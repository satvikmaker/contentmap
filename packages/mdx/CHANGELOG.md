# @contentmap/mdx

## 1.2.0

### Patch Changes

- Updated dependencies [276cd18]
  - contentmap@1.2.0

## 1.1.0

### Minor Changes

- e1ef21b: `mdx({ compat: 'mdx-bundler' })` makes compiled MDX run under mdx-bundler's `getMDXComponent` as well as under `run()`. contentlayer and content-collections pages render `body.code` that way — `useMDXComponent` from next-contentlayer, pliny's `MDXLayoutRenderer` — so a migrated site keeps rendering without a single page changing.
- 395df94: New `minify` option: `mdx({ minify: true })` runs the compiled output through esbuild.

  Nothing reads that JavaScript — it is written to disk and handed to a bundler — and unminified it is roughly 2.5× the size. Migrating [neobrutalism-components](https://github.com/ekmas/neobrutalism-components), one page compiled to 52,316 characters here against 20,693 from Velite, which has always minified, and the 54-document corpus wrote 7.69 MB against 3.04 MB. With the option on it writes 3.30 MB and every one of the 53 prerendered pages still renders identically.

  esbuild is an **optional peer**, the same bargain `@contentmap/unified` makes for `rehype-raw`: leave the option off and nothing about your install changes. It composes with `compat: 'mdx-bundler'`, which is minified along with the wrapper.

### Patch Changes

- Updated dependencies [07dce53]
- Updated dependencies [375b075]
- Updated dependencies [3e5a180]
- Updated dependencies [07dce53]
- Updated dependencies [abd668a]
  - contentmap@1.1.0

## 1.0.1

### Patch Changes

- Updated dependencies
  - contentmap@1.0.1

## 1.0.0

### Patch Changes

- Updated dependencies
  - contentmap@1.0.0

## 0.5.2

### Patch Changes

- Updated dependencies
  - contentmap@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies
  - contentmap@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies
  - contentmap@0.5.0

## 0.4.1

### Patch Changes

- Updated dependencies
  - contentmap@0.4.1

## 0.4.0

### Patch Changes

- Updated dependencies
  - contentmap@0.4.0
