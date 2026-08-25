# Contributing

## The public API is snapshotted

Every exported symbol of every package is recorded under [`api/`](api). If you change a signature, CI fails until the snapshot is updated:

```sh
pnpm api:snapshot
```

Commit the result. **The diff is the review** — that is the whole point. A one-line change under `api/` is a change every consumer sees, and it should be as visible in a pull request as the code that caused it.

The snapshot is generated from the emitted `.d.ts`, not from source, because that is what a consumer actually resolves.

## Compatibility

From 1.0, contentmap follows semver.

|           |                                                                               |
| --------- | ----------------------------------------------------------------------------- |
| **Patch** | Bug fixes. No API change                                                      |
| **Minor** | New options, new packages, new context methods. Existing code keeps compiling |
| **Major** | A signature narrows, an export disappears, or a default changes behaviour     |

**Deprecation policy.** Anything being removed is deprecated first: marked `@deprecated` with the replacement named, kept working for at least one minor release, and listed in the changelog. Nothing is removed in a minor.

Two things are explicitly _not_ part of the public API and may change in a patch:

- the shape of files written to the output directory — import from `contentmap/generated`, never from a path inside it
- anything reachable only by deep-importing a `dist/` path that the `exports` map does not name

## Before you push

```sh
pnpm build && pnpm typecheck && pnpm test
pnpm api:check          # the public surface still matches api/
pnpm verify:types       # a user-shaped project still compiles
pnpm verify:cli         # the shipped binary still behaves
pnpm verify:docs        # the READMEs still describe the real API
pnpm verify:migrate     # migrated configs still build
```

`pnpm verify:examples` builds Next, Nuxt, Astro and webpack against their real toolchains. It is slow, and it is the only thing that catches an adapter breaking.

## Tests

A test that cannot fail is worse than no test. If you add one, try breaking the code it covers and confirm it goes red — several tests in this repository were found to pass with the feature they described removed entirely.

Watch-mode tests are timing-sensitive by nature: `watcher.add()` returns before the OS watch is live, so a single write immediately afterwards can go unreported. Assert the eventual guarantee, not the first event.
