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
  for (const pkg of ['markdown', 'unified', 'image']) {
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

process.exitCode = failures === 0 ? 0 : 1
