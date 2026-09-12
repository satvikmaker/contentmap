// Migrate a real application, build it, and measure both sides.
//
// The other benchmarks here run synthetic corpora this repository generates.
// This one takes a project nobody here wrote — tailwind-nextjs-starter-blog,
// pinned to a commit — runs the codemod on it, applies the application-code
// patch beside this file, and builds it with both tools. Every number in the
// README's real-world section comes from this script.
//
//   node --experimental-strip-types scripts/real-world.mjs [--packs <dir>] [--keep]
//
// Needs network, git, yarn and a few minutes, so it is not part of CI: it
// clones and installs a third-party project. `--packs` installs `pnpm pack`
// tarballs instead of the published packages, which is how a release is
// measured before it exists on npm.
import { cp, mkdtemp, readFile, rm, stat, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { cpus, loadavg, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '..')
const REPO_URL = 'https://github.com/timlrx/tailwind-nextjs-starter-blog.git'
const PIN = 'b45bef66b40c63b6f57c15ee8cd090682238df4c'
const PATCH = join(repo, 'scripts/real-world/tailwind-nextjs-starter-blog.patch')
// Read rather than pinned: these tarballs are named after whatever version the
// working tree is at, so a release would otherwise leave the script looking for
// files that `pnpm pack` no longer writes.
const VERSION = JSON.parse(
  await readFile(join(repo, 'packages/contentmap/package.json'), 'utf8')
).version
const tarball = name => `${name}-${VERSION}.tgz`
const PAIRS = 3

const args = process.argv.slice(2)
const packs = args.includes('--packs') ? resolve(args[args.indexOf('--packs') + 1]) : undefined
const keep = args.includes('--keep')
// Before the clone, so a mispacked tarball costs a second rather than a
// clone, two installs and the first half of the measurements.
if (packs) checkPacks(packs)

function run(command, cwd, { fatal = false } = {}) {
  const result = spawnSync(command[0], command.slice(1), { cwd, encoding: 'utf8' })
  if (fatal && result.status !== 0) {
    console.log(result.stdout?.slice(-3000) ?? '')
    console.log(result.stderr?.slice(-2000) ?? '')
    throw new Error(`${command.join(' ')} failed in ${cwd}`)
  }
  return result
}

/** Wall-clock seconds for a cold build: no .next, no generated content. */
async function coldBuild(dir) {
  for (const generated of ['.next', '.contentlayer', '.contentmap']) {
    await rm(join(dir, generated), { recursive: true, force: true })
  }
  const load = loadavg()[0]
  const started = performance.now()
  run(['yarn', 'build'], dir, { fatal: true })
  return { seconds: (performance.now() - started) / 1000, load }
}

/**
 * Time both sides in pairs, and report the ratio rather than the seconds.
 *
 * A development machine is rarely quiet, and absolute seconds measured on a
 * busy one are not comparable to anything. Two builds run back to back meet
 * the same contention, so the within-pair ratio still says which is faster.
 * A pair whose load moved more than DRIFT between its halves is dropped, not
 * averaged in — that is the shape of the one run that first produced a
 * 94-second outlier here.
 */
async function timePairs(work, pairs = PAIRS) {
  const DRIFT = 0.25
  const kept = []
  for (let i = 1; i <= pairs; i++) {
    // The order alternates too, so neither side always runs second.
    const order = i % 2 === 1 ? ['before', 'after'] : ['after', 'before']
    const runs = {}
    for (const side of order) runs[side] = await coldBuild(join(work, side))
    const drift =
      Math.abs(runs.before.load - runs.after.load) / Math.max(runs.before.load, runs.after.load)
    const usable = drift <= DRIFT
    console.log(
      `  pair ${i}: before ${runs.before.seconds.toFixed(1)}s  after ${runs.after.seconds.toFixed(1)}s` +
        `  ${usable ? `ratio ${(runs.after.seconds / runs.before.seconds).toFixed(2)}` : `dropped, load moved ${(drift * 100).toFixed(0)}%`}`
    )
    if (usable) kept.push(runs)
  }
  return kept
}

/** Bytes and package count under a directory, counting each package once. */
async function footprint(dir) {
  let packages = 0
  let bytes = 0
  const walk = async path => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) {
        // A scope directory holds packages, not a package itself.
        if (entry.name.startsWith('@')) packages += (await readdir(child)).length
        else if (existsSync(join(child, 'package.json'))) packages++
        await walk(child)
      } else if (entry.isFile()) {
        bytes += (await stat(child)).size
      }
    }
  }
  await walk(dir).catch(() => undefined)
  return { packages, bytes }
}

/**
 * Refuse tarballs that still name workspace dependencies.
 *
 * `npm pack` in this repository leaves `"contentmap": "workspace:^"` in the
 * packed manifest, and npm then fails the install with EUNSUPPORTEDPROTOCOL
 * several minutes into a run. `pnpm pack` resolves those to real versions.
 */
function checkPacks(dir) {
  for (const name of ['contentmap', 'contentmap-next', 'contentmap-mdx']) {
    const path = join(dir, tarball(name))
    const { stdout, status } = spawnSync('tar', ['-xzOf', path, 'package/package.json'], {
      encoding: 'utf8'
    })
    if (status !== 0) throw new Error(`cannot read ${path} — was it packed?`)
    if (stdout.includes('workspace:')) {
      throw new Error(`${name} was packed by npm and still names workspace:. Use \`pnpm pack\`.`)
    }
  }
}

/**
 * What each content layer adds to a project that already has Next.
 *
 * Measured as a delta, not as a raw closure, because the raw closures are not
 * comparable: `next-contentlayer2` declares `next` as a dependency, so
 * installing it alone drags in Next and React and reports 434 MB, while
 * `@contentmap/next` takes next as a peer and reports 13.7 MB. Subtracting a
 * baseline that already holds next and react measures the thing a project
 * actually decides — and it is the honest direction, since it hands
 * contentlayer back everything it was being charged for.
 */
async function installClosure(work) {
  const of = async (name, specs) => {
    const dir = join(work, `closure-${name}`)
    run(['mkdir', '-p', dir], work)
    await writeFile(join(dir, 'package.json'), '{ "name": "closure", "private": true }\n')
    run(['npm', 'install', '--no-audit', '--no-fund', '--ignore-scripts', ...specs], dir, {
      fatal: true
    })
    return footprint(join(dir, 'node_modules'))
  }
  const BASE = ['next', 'react', 'react-dom']
  const mine = packs
    ? [
        join(packs, tarball('contentmap')),
        join(packs, tarball('contentmap-next')),
        join(packs, tarball('contentmap-mdx')),
        'zod'
      ]
    : ['contentmap', '@contentmap/next', '@contentmap/mdx', 'zod']

  const baseline = await of('baseline', BASE)
  const withContentlayer = await of('contentlayer', [
    ...BASE,
    'contentlayer2@0.5.8',
    'next-contentlayer2@0.5.8'
  ])
  const withContentmap = await of('contentmap', [...BASE, ...mine])
  const added = (name, total) => ({
    packages: total.packages - baseline.packages,
    bytes: total.bytes - baseline.bytes,
    name
  })
  return {
    baseline,
    contentlayer: added('contentlayer', withContentlayer),
    contentmap: added('contentmap', withContentmap)
  }
}

/**
 * Wait for the machine to be quiet.
 *
 * A build timed under load says more about what else was running than about
 * the tool. The bench script applies the same rule.
 */
async function untilIdle(limit = cpus().length * 0.5, seconds = 600) {
  for (let waited = 0; waited < seconds; waited += 10) {
    if (loadavg()[0] < limit) return true
    await new Promise(done => setTimeout(done, 10_000))
  }
  return false
}

const mb = (bytes, digits = 1) => `${(bytes / 1_000_000).toFixed(digits)} MB`
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const same = async (a, b) => (await readFile(a)).equals(await readFile(b))

const work = await mkdtemp(join(tmpdir(), 'contentmap-real-world-'))
try {
  console.log(`cloning ${REPO_URL.split('/').slice(-2).join('/')} at ${PIN.slice(0, 12)}`)
  run(['git', 'clone', '--quiet', REPO_URL, join(work, 'before')], work, { fatal: true })
  run(['git', 'checkout', '--quiet', PIN], join(work, 'before'), { fatal: true })
  await cp(join(work, 'before'), join(work, 'after'), {
    recursive: true,
    filter: source => !source.includes(`${'.git'}/`)
  })

  console.log('migrating with @contentmap/migrate')
  const migrated = run(
    [process.execPath, join(repo, 'packages/migrate/dist/cli.js'), '--root', join(work, 'after')],
    work,
    { fatal: true }
  )
  console.log(
    migrated.stdout
      .trim()
      .split('\n')
      .map(line => `  ${line}`)
      .join('\n')
  )

  // The report's own advice: this starter formats and sorts dates as strings.
  const config = join(work, 'after/contentmap.config.ts')
  const source = await readFile(config, 'utf8')
  await writeFile(
    config,
    source
      .replace('date: z.coerce.date(),', 'date: z.coerce.date().transform(d => d.toISOString()),')
      .replace(
        'lastmod: z.coerce.date().optional(),',
        'lastmod: z.coerce.date().transform(d => d.toISOString()).optional(),'
      )
  )
  // The report's last line: the old config is left alone, and `next build`
  // type-checks it.
  await rm(join(work, 'after/contentlayer.config.ts'))
  run(['patch', '-p1', '-i', PATCH], join(work, 'after'), { fatal: true })

  if (packs) {
    const manifest = join(work, 'after/package.json')
    const pkg = JSON.parse(await readFile(manifest, 'utf8'))
    const local = name => `file:${join(packs, name)}`
    pkg.dependencies['contentmap'] = local(tarball('contentmap'))
    pkg.dependencies['@contentmap/next'] = local(tarball('contentmap-next'))
    pkg.dependencies['@contentmap/mdx'] = local(tarball('contentmap-mdx'))
    // The adapter takes contentmap as a peer; without this the published one
    // is installed beside the tarball being measured.
    pkg.resolutions = { contentmap: local(tarball('contentmap')) }
    await writeFile(manifest, `${JSON.stringify(pkg, null, 2)}\n`)
  }

  console.log('measuring what each content layer costs to install')
  const closure = await installClosure(work)

  for (const side of ['before', 'after']) {
    console.log(`installing ${side}`)
    run(['yarn', 'install'], join(work, side), { fatal: true })
  }

  const idle = await untilIdle()
  if (!idle) console.log('machine never went idle; reporting the paired ratio only')
  console.log('timing cold builds')
  const timed = await timePairs(work)

  const generated = {
    contentlayer: await footprint(join(work, 'before/.contentlayer')),
    contentmap: await footprint(join(work, 'after/.contentmap'))
  }
  const feed = await same(join(work, 'before/public/feed.xml'), join(work, 'after/public/feed.xml'))

  console.log(`\n=== tailwind-nextjs-starter-blog @ ${PIN.slice(0, 12)}, 13 documents ===`)
  const row = (label, before, after) =>
    console.log(`${label.padEnd(18)}${before.padStart(12)}  ->${after.padStart(12)}`)
  console.log(
    `  baseline: next + react, ${closure.baseline.packages} packages, ${mb(closure.baseline.bytes)}`
  )
  row('install adds', `${closure.contentlayer.packages} pkg`, `${closure.contentmap.packages} pkg`)
  row('', mb(closure.contentlayer.bytes), mb(closure.contentmap.bytes))
  row('generated data', mb(generated.contentlayer.bytes, 2), mb(generated.contentmap.bytes, 2))
  if (timed.length) {
    const seconds = side => timed.map(pair => pair[side].seconds)
    row(
      'cold build',
      `${median(seconds('before')).toFixed(1)}s`,
      `${median(seconds('after')).toFixed(1)}s`
    )
    const spread = side => {
      const all = seconds(side).sort((a, b) => a - b)
      return `${all[0].toFixed(1)}-${all[all.length - 1].toFixed(1)}s`
    }
    // The spread matters more than the median here: contentlayer's build has
    // twice come in near 93s where it usually takes 21s, and a median alone
    // hides that it happened at all.
    console.log(
      `  medians of ${timed.length} pairs; spread ${spread('before')} and ${spread('after')}`
    )
    const ratios = timed.map(pair => pair.after.seconds / pair.before.seconds)
    console.log(
      `  paired ratio ${median(ratios).toFixed(2)}` +
        `${idle ? ', measured from an idle machine' : ', on a machine that never went idle'}`
    )
  } else {
    console.log('cold build        no pair survived the load check; no timing to report')
  }
  console.log(`feed.xml          ${feed ? 'byte-identical' : 'DIFFERS'}`)
  console.log(`load at end       ${loadavg()[0].toFixed(2)} on ${cpus().length} cores`)
} finally {
  if (keep) console.log(`kept ${work}`)
  else await rm(work, { recursive: true, force: true, maxRetries: 5 })
}
