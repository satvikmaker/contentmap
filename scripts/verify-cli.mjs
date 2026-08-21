// The CLI's contract, exercised as a real process.
//
// In-process tests import `run()` from source, where the config is loaded
// through vitest's transform rather than through jiti. The error a user
// actually sees comes from the shipped binary, so that is what this checks:
// exit codes, the wording of failures, and the promise that `check` writes
// nothing.
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repo = resolve(import.meta.dirname, '..')
const cli = join(repo, 'packages/contentmap/dist/cli.js')

const CONFIG = `import { defineConfig, defineCollection } from 'contentmap'
import { z } from 'zod'
const posts = defineCollection({
  name: 'posts', directory: 'content', include: '**/*.md',
  schema: z.object({ title: z.string() })
})
export default defineConfig({ collections: { posts } })
`

let failures = 0
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`PASS  ${label}`)
  } else {
    failures++
    console.log(`FAIL  ${label}`)
    if (detail)
      console.log(
        String(detail)
          .split('\n')
          .map(l => `      ${l}`)
          .join('\n')
      )
  }
}

async function project(files) {
  const root = await mkdtemp(join(repo, '.cli-'))
  await mkdir(join(root, 'node_modules'), { recursive: true })
  const { symlink } = await import('node:fs/promises')
  await symlink(join(repo, 'packages/contentmap'), join(root, 'node_modules/contentmap'), 'dir')
  await symlink(join(repo, 'node_modules/zod'), join(root, 'node_modules/zod'), 'dir')
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true }).catch(() => {})
    await writeFile(join(root, path), content)
  }
  return root
}

const at = (root, args) =>
  spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' })

// A syntax error in the config is the most common first-run failure. It has to
// name the file, the line, and show the offending source.
{
  const root = await project({ 'contentmap.config.ts': 'export default { this is not valid‽ }' })
  try {
    const r = at(root, ['build'])
    const out = r.stdout + r.stderr
    check('broken config: non-zero exit', r.status !== 0, out)
    check('broken config: names the file', out.includes('contentmap.config.ts'), out)
    check('broken config: gives a line number', /contentmap\.config\.ts:\d+/.test(out), out)
    check('broken config: shows the source line', out.includes('export default'), out)
    check('broken config: no raw stack trace', !out.includes('at Object.'), out)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

// A missing config must say what it looked for, not throw ENOENT at the user.
{
  const root = await project({})
  try {
    const r = at(root, ['build'])
    const out = r.stdout + r.stderr
    check('missing config: non-zero exit', r.status !== 0, out)
    check('missing config: mentions the config', /config/i.test(out), out)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

// `check` exists so CI can validate without artifacts. One stray file makes it
// useless in a pipeline that diffs the tree afterwards.
{
  const root = await project({
    'contentmap.config.ts': CONFIG,
    'content/a.md': '---\ntitle: A\n---\nbody\n'
  })
  try {
    const r = at(root, ['check'])
    const entries = await readdir(root)
    check('check: exits 0 on a valid corpus', r.status === 0, r.stdout + r.stderr)
    check('check: writes nothing', !entries.includes('.contentmap'), entries.join(', '))
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

// A schema violation must fail the build and point at the document.
{
  const root = await project({
    'contentmap.config.ts': CONFIG,
    'content/bad.md': '---\ntitle: 42\n---\nbody\n'
  })
  try {
    const r = at(root, ['build'])
    const out = r.stdout + r.stderr
    check('invalid document: non-zero exit', r.status !== 0, out)
    check('invalid document: names the file', out.includes('bad.md'), out)

    const j = at(root, ['build', '--json'])
    let parsed
    try {
      parsed = JSON.parse(j.stdout)
    } catch {
      parsed = undefined
    }
    check(
      '--json: parseable even when the build fails',
      parsed !== undefined,
      j.stdout.slice(0, 300)
    )
    check('--json: reports ok=false', parsed?.ok === false, JSON.stringify(parsed)?.slice(0, 200))
    check('--json: carries the diagnostic', (parsed?.diagnostics?.length ?? 0) > 0)
    check(
      '--json: no code frame drawing in the payload',
      !j.stdout.includes('│'),
      j.stdout.slice(0, 200)
    )
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

// --version has to be the version people report bugs against.
{
  const root = await project({})
  try {
    const r = at(root, ['--version'])
    const pkg = JSON.parse(
      await (
        await import('node:fs/promises')
      ).readFile(join(repo, 'packages/contentmap/package.json'), 'utf8')
    )
    check(
      '--version: matches the manifest',
      r.stdout.trim() === pkg.version,
      `${r.stdout.trim()} vs ${pkg.version}`
    )
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

process.exitCode = failures === 0 ? 0 : 1
