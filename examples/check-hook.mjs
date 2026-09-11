// Proves an example's framework build ran contentmap's afterBuild hook — the
// integration, not the CLI, since nothing else runs during these builds.
//
// `reset` deletes the hook's output first, so `verify` afterwards cannot be
// satisfied by a file an earlier build left behind.
import { readFile, rm } from 'node:fs/promises'

const FILE = 'public/search.json'
const [command] = process.argv.slice(2)

if (command === 'reset') {
  await rm(FILE, { force: true })
} else if (command === 'verify') {
  const entries = JSON.parse(await readFile(FILE, 'utf8').catch(() => 'null'))
  if (!Array.isArray(entries) || entries.length === 0) {
    console.error(`FAIL  afterBuild did not write ${FILE} during this build`)
    process.exit(1)
  }
  console.log(
    `PASS  afterBuild wrote ${FILE} (${entries.length} entries) during the framework build`
  )
} else {
  console.error('usage: node check-hook.mjs reset|verify')
  process.exit(2)
}
