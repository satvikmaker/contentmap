// Type-check the config examples in the READMEs against the built package.
//
// `renderers: [markdown()]` was documented in three places and the option is
// called `renderer`. Anyone following those READMEs got "No renderer
// configured" from a copy-paste of our own docs. Documentation that asserts an
// API is a test nobody runs — unless something runs it.
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from 'node:fs/promises'
import { join, resolve, basename } from 'node:path'
import { spawnSync } from 'node:child_process'

const repo = resolve(import.meta.dirname, '..')

const DOCS = [
  'README.md',
  'packages/markdown/README.md',
  'packages/unified/README.md',
  'packages/image/README.md',
  'packages/vite/README.md',
  'packages/next/README.md',
  'packages/nuxt/README.md',
  'packages/astro/README.md',
  'packages/webpack/README.md',
  'packages/mdx/README.md',
  'packages/migrate/README.md'
]

/** ```ts blocks that define a contentmap config. */
function configBlocks(markdown) {
  const out = []
  const fence = /```(ts|typescript)\n([\s\S]*?)```/g
  let m
  while ((m = fence.exec(markdown)) !== null) {
    const code = m[2]
    if (code.includes('defineConfig(') && code.includes("from 'contentmap'")) out.push(code)
  }
  return out
}

let failures = 0
const root = await mkdtemp(join(repo, '.docs-'))
try {
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await symlink(join(repo, 'packages/contentmap'), join(root, 'node_modules/contentmap'), 'dir')
  await symlink(join(repo, 'node_modules/zod'), join(root, 'node_modules/zod'), 'dir')
  for (const pkg of ['markdown', 'unified', 'image', 'mdx']) {
    await mkdir(join(root, 'node_modules/@contentmap'), { recursive: true }).catch(() => {})
    await symlink(
      join(repo, 'packages', pkg),
      join(root, `node_modules/@contentmap/${pkg}`),
      'dir'
    ).catch(() => {})
  }
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        lib: ['esnext'],
        strict: true,
        noEmit: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        skipLibCheck: true,
        types: []
      },
      include: ['**/*.ts']
    })
  )

  // Doc examples import plugins from the wider ecosystem. Whether those are
  // installed here is not the question; whether OUR options are spelled right
  // is. Declared as `any` so a missing third-party package cannot mask, or
  // manufacture, a failure.
  await writeFile(
    join(root, 'shims.d.ts'),
    "declare module 'rehype-*'\ndeclare module 'remark-*'\ndeclare module 'astro:content'\ndeclare module 'velite'\n"
  )

  let n = 0
  for (const doc of DOCS) {
    const source = await readFile(join(repo, doc), 'utf8').catch(() => undefined)
    if (source === undefined) continue
    for (const [i, code] of configBlocks(source).entries()) {
      const name = `${basename(resolve(repo, doc, '..'))}-${i}.ts`
      await writeFile(join(root, name), code)
      n++
    }
  }

  if (n === 0) {
    console.log('FAIL  no config examples found — the extractor is broken, not the docs')
    failures++
  } else {
    const tsc = spawnSync(
      process.execPath,
      [
        join(repo, 'node_modules/typescript/bin/tsc'),
        '--noEmit',
        '-p',
        join(root, 'tsconfig.json')
      ],
      { encoding: 'utf8' }
    )
    if (tsc.status === 0) {
      console.log(
        `PASS  ${n} config example(s) in the READMEs type-check against the built package`
      )
    } else {
      failures++
      console.log('FAIL  a documented config does not compile')
      console.log(tsc.stdout.trim())
    }
  }
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
}

// The README also names APIs in prose and in example chains, and both drift as
// readily as a config block. `renderers` vs `renderer` was caught by
// type-checking the examples; nothing checked the sentence listing every
// context method, nor the query chain in the quickstart.
{
  const readme = await readFile(join(repo, 'README.md'), 'utf8')
  const types = await readFile(join(repo, 'packages/contentmap/src/types.ts'), 'utf8')
  const runtime = await readFile(join(repo, 'packages/contentmap/src/runtime/index.ts'), 'utf8')

  // "Inside `transform`, `ctx` gives you: `meta`, `body`, `markdown()`, …"
  const sentence = readme.slice(readme.indexOf('### Transform context'))
  const listed = sentence.slice(0, sentence.indexOf('\n\n', sentence.indexOf('gives you')))
  const claimed = [...listed.matchAll(/`([a-z][A-Za-z]*)\(\)`|`([a-z][A-Za-z]*)`/g)]
    .map(m => m[1] ?? m[2])
    .filter(name => name !== 'ctx' && name !== 'transform')

  const ctxBody = types.slice(types.indexOf('export interface TransformContext'))
  const ctx = ctxBody.slice(0, ctxBody.indexOf('\n}'))
  const missingCtx = [...new Set(claimed)].filter(
    name => !new RegExp(`\\b${name}[?]?[(<:]`).test(ctx)
  )
  if (claimed.length === 0) {
    failures++
    console.log('FAIL  could not read the context-method sentence; this check is stale')
  } else if (missingCtx.length === 0) {
    console.log(`PASS  every context member the README names exists (${claimed.length} checked)`)
  } else {
    failures++
    console.log(`FAIL  README names context members that do not exist: ${missingCtx.join(', ')}`)
  }

  // Every `.method(` used in a documented query chain has to be on Query.
  const chains = [...readme.matchAll(/```(?:ts|typescript)\n([\s\S]*?)```/g)]
    .map(m => m[1])
    .filter(code => code.includes('contentmap/generated'))
    .join('\n')
  const used = [...new Set([...chains.matchAll(/\.([a-z][A-Za-z]*)\(/g)].map(m => m[1]))]
  const queryBody = runtime.slice(runtime.indexOf('export interface Query'))
  const query = queryBody.slice(0, queryBody.indexOf('\n}'))
  const missingQuery = used.filter(
    name => !new RegExp(`\\b${name}[<(]`).test(query) && !['map', 'join', 'filter'].includes(name)
  )
  if (used.length === 0) {
    failures++
    console.log('FAIL  no documented query chain found; this check is stale')
  } else if (missingQuery.length === 0) {
    console.log(`PASS  every query method the README uses exists (${used.length} checked)`)
  } else {
    failures++
    console.log(`FAIL  README uses query methods that do not exist: ${missingQuery.join(', ')}`)
  }
}

process.exitCode = failures === 0 ? 0 : 1
