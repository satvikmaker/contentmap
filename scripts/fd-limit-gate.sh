#!/usr/bin/env bash
# Regression gate for the silent-data-loss class of bug.
#
# Under a low file-descriptor limit, content-collections lost 2,758 of 3,000
# documents and exited 0. A build that cannot read its corpus MUST fail loudly.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d "$here/.fdgate-XXXXXX")"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/content"
for i in $(seq 1 3000); do
  printf -- '---\ntitle: Post %s\n---\nbody\n' "$i" > "$work/content/p$i.md"
done

cat > "$work/contentmap.config.ts" <<CONFIG
import { defineConfig, defineCollection } from '$here/packages/contentmap/src/index.ts'
import { z } from 'zod'
const posts = defineCollection({
  name: 'posts', directory: 'content', include: '**/*.md',
  schema: z.object({ title: z.string(), content: z.string() })
})
export default defineConfig({ collections: { posts } })
CONFIG

run() {
  ( ulimit -n "$1" 2>/dev/null || true
    cd "$work" && node "$here/packages/contentmap/dist/cli.js" build --json 2>&1 )
}

echo "--- baseline (default fd limit) ---"
base="$(run 4096)"
base_docs="$(printf '%s' "$base" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).documents)}catch{console.log(-1)}})')"
echo "documents=$base_docs"
if [ "$base_docs" != "3000" ]; then
  echo "FAIL: baseline build did not produce 3000 documents (got $base_docs)"; exit 1
fi

echo "--- constrained (ulimit -n 64) ---"
out="$(run 64)"
status=$?
docs="$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).documents)}catch{console.log(-1)}})')"
echo "exit=$status documents=$docs"

# Either we read everything (bounded concurrency held), or we failed loudly.
# Silently succeeding with a truncated corpus is the defect under test.
if [ "$docs" = "3000" ] && [ "$status" -eq 0 ]; then
  echo "PASS: bounded concurrency read the full corpus under a 64-fd limit"
  exit 0
fi
if [ "$status" -ne 0 ]; then
  echo "PASS: build failed loudly rather than truncating"
  exit 0
fi
echo "FAIL: exited 0 with only $docs/3000 documents — silent data loss"
exit 1
