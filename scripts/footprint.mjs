// Publish the REAL install footprint, not the `dependencies` field.
//
// velite advertises four dependencies and installs 131 packages, because
// everything else is listed as a devDependency and inlined at build time. A
// number a user cannot verify with `npm install` is marketing.
import { execFile } from 'node:child_process'
import { mkdtemp, rm, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const CM = process.cwd()

/**
 * Count installed packages.
 *
 * Only direct children of a `node_modules` directory count, and recursion only
 * follows `node_modules`. Walking inside a package counts its subpath
 * `package.json` files — zod ships several — and inflates every total.
 */
async function countPackages(nodeModules) {
  let packages = 0
  let bytes = 0

  const sizeOf = async p => {
    let entries
    try {
      entries = await readdir(p, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const child = join(p, e.name)
      if (e.isDirectory()) await sizeOf(child)
      else {
        try {
          bytes += (await stat(child)).size
        } catch {}
      }
    }
  }

  const walk = async dir => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      const child = join(dir, e.name)
      if (e.name.startsWith('@')) {
        // A scope directory holds packages, not a package itself.
        for (const scoped of await readdir(child, { withFileTypes: true })) {
          if (!scoped.isDirectory()) continue
          packages++
          await walk(join(child, scoped.name, 'node_modules'))
        }
        continue
      }
      packages++
      await walk(join(child, 'node_modules'))
    }
  }

  await walk(nodeModules)
  await sizeOf(nodeModules)
  return { packages, bytes }
}

async function measure(spec, extra = []) {
  const dir = await mkdtemp(join(tmpdir(), 'fp-'))
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fp', private: true }))
    await run('npm', ['install', '--silent', '--no-audit', '--no-fund', spec, ...extra], {
      cwd: dir,
      timeout: 300_000
    })
    return await countPackages(join(dir, 'node_modules'))
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  }
}

const packed = await run('npm', ['pack', '--pack-destination', tmpdir()], {
  cwd: join(CM, 'packages/contentmap')
})
const tarball = join(tmpdir(), packed.stdout.trim().split('\n').pop())

const mb = n => `${(n / 1024 ** 2).toFixed(1)} MB`
const rows = [
  ['contentmap', await measure(tarball)],
  ['contentmap + zod', await measure(tarball, ['zod@^4'])]
]
for (const [name, r] of rows) {
  console.log(`${name.padEnd(22)} ${String(r.packages).padStart(4)} packages   ${mb(r.bytes)}`)
}
await rm(tarball, { force: true })
