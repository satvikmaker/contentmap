import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface InitOptions {
  root: string
  /** Overwrite files that already exist. */
  force?: boolean
}

export interface InitResult {
  created: string[]
  updated: string[]
  skipped: string[]
  detected: string
  notes: string[]
}

interface Detected {
  name: string
  contentDir: string
  hint: string
}

/**
 * Scaffold a project.
 *
 * Never overwrites without `--force`. A config file is something people edit,
 * and silently replacing one is worse than doing nothing — velite documents an
 * `init` command it never shipped, which at least fails honestly.
 */
export async function init(options: InitOptions): Promise<InitResult> {
  const { root, force = false } = options
  const result: InitResult = { created: [], updated: [], skipped: [], detected: '', notes: [] }

  const pkg = await readJson(join(root, 'package.json'))
  const detected = detect(pkg)
  result.detected = detected.name
  result.notes.push(detected.hint)

  const configPath = join(root, 'contentmap.config.ts')
  if (!force && (await exists(configPath))) {
    result.skipped.push('contentmap.config.ts')
  } else {
    await writeFile(configPath, configTemplate(detected.contentDir), 'utf8')
    result.created.push('contentmap.config.ts')
  }

  const samplePath = join(root, detected.contentDir, 'posts', 'hello-world.md')
  if (!force && (await exists(samplePath))) {
    result.skipped.push(relativeName(detected.contentDir, 'posts/hello-world.md'))
  } else {
    await mkdir(join(root, detected.contentDir, 'posts'), { recursive: true })
    await writeFile(samplePath, SAMPLE, 'utf8')
    result.created.push(relativeName(detected.contentDir, 'posts/hello-world.md'))
  }

  if (await addTsconfigPath(root)) result.updated.push('tsconfig.json')
  else result.notes.push('Add "contentmap/generated": ["./.contentmap"] to compilerOptions.paths.')

  if (await addGitignore(root)) result.updated.push('.gitignore')

  return result
}

function detect(pkg: Record<string, unknown> | undefined): Detected {
  const deps = {
    ...(pkg?.['dependencies'] as Record<string, string> | undefined),
    ...(pkg?.['devDependencies'] as Record<string, string> | undefined)
  }
  const has = (name: string): boolean => name in deps

  if (has('next')) {
    return {
      name: 'Next.js',
      contentDir: 'content',
      hint: 'Wrap next.config with withContentmap from @contentmap/next. Works on Turbopack and webpack.'
    }
  }
  if (has('nuxt')) {
    return {
      name: 'Nuxt',
      contentDir: 'content',
      hint: 'Add @contentmap/nuxt to `modules` in nuxt.config.'
    }
  }
  if (has('astro')) {
    return {
      name: 'Astro',
      contentDir: 'src/content',
      hint: 'Use contentmapLoader() from @contentmap/astro as a collection loader in src/content.config.ts.'
    }
  }
  if (has('@sveltejs/kit')) {
    return {
      name: 'SvelteKit',
      contentDir: 'content',
      hint: 'Add contentmap() from @contentmap/vite to plugins, and alias contentmap/generated in svelte.config.js kit.alias.'
    }
  }
  if (has('vite')) {
    return {
      name: 'Vite',
      contentDir: 'content',
      hint: 'Add contentmap() from @contentmap/vite to plugins in vite.config.'
    }
  }
  return {
    name: 'no framework detected',
    contentDir: 'content',
    hint: 'Run `contentmap build` directly, or add it to your build script.'
  }
}

function configTemplate(contentDir: string): string {
  return `import { defineCollection, defineConfig } from 'contentmap'
import { z } from 'zod'

const posts = defineCollection({
  name: 'posts',
  directory: '${contentDir}/posts',
  include: '**/*.md',
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    draft: z.boolean().default(false)
  }),
  transform: (doc, ctx) => ({
    ...doc,
    slug: ctx.meta.slug
  })
})

export default defineConfig({
  collections: { posts }
})
`
}

const SAMPLE = `---
title: Hello world
date: 2026-01-01
---

Your first document. Run \`contentmap build\`, then import it:

\`\`\`ts
import { posts } from 'contentmap/generated'

const recent = posts.select('title', 'slug').sortBy('date', 'desc').limit(5).all()
\`\`\`
`

/**
 * Register the path alias.
 *
 * Editing tsconfig by hand is the step people most often miss, and every
 * bundler in this space resolves generated output through it — including
 * Turbopack, which supports no plugins at all.
 */
async function addTsconfigPath(root: string): Promise<boolean> {
  const path = join(root, 'tsconfig.json')
  const source = await readText(path)
  if (source === undefined) return false
  if (source.includes('contentmap/generated')) return false

  // Rewritten textually rather than reparsed, so comments and formatting in a
  // hand-maintained tsconfig survive.
  const withPaths = /"paths"\s*:\s*\{/.exec(source)
  if (withPaths) {
    const at = withPaths.index + withPaths[0].length
    const patched = `${source.slice(0, at)}\n      "contentmap/generated": ["./.contentmap"],${source.slice(at)}`
    await writeFile(path, patched, 'utf8')
    return true
  }

  const withCompiler = /"compilerOptions"\s*:\s*\{/.exec(source)
  if (withCompiler) {
    const at = withCompiler.index + withCompiler[0].length
    const patched = `${source.slice(0, at)}\n    "paths": {\n      "contentmap/generated": ["./.contentmap"]\n    },${source.slice(at)}`
    await writeFile(path, patched, 'utf8')
    return true
  }
  return false
}

async function addGitignore(root: string): Promise<boolean> {
  const path = join(root, '.gitignore')
  const source = (await readText(path)) ?? ''
  if (source.split(/\r?\n/).some(line => line.trim() === '.contentmap')) return false
  const next = source.endsWith('\n') || source === '' ? source : `${source}\n`
  await writeFile(path, `${next}\n# contentmap generated output\n.contentmap\n`, 'utf8')
  return true
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  const text = await readText(path)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return undefined
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function relativeName(dir: string, rest: string): string {
  return `${dir}/${rest}`
}
