# @contentmap/unified

## 1.2.0

### Patch Changes

- Updated dependencies [276cd18]
  - contentmap@1.2.0

## 1.1.0

### Patch Changes

- e287773: `remarkPlugins` and `rehypePlugins` now accept a configured plugin, `[plugin, options]`.

  That tuple is how every remark/rehype config in the ecosystem passes options, but it was handed to unified's `use()` whole — and `use()` reads a bare array as a _list_ of pluggables, so the options object was taken for a preset and rejected with `Expected usable value but received an empty preset`. Migrating [svgl](https://github.com/pheralb/svgl), which configures shiki that way, failed on every document. The option types were `readonly Plugin[]`, which could not express a configured plugin either; they are now `readonly UnifiedPlugin[]`, a type this package exports.

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

## 0.3.1

### Patch Changes

- Updated dependencies
  - contentmap@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies
  - contentmap@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies
  - contentmap@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies
  - contentmap@0.1.1

## 0.1.0

### Patch Changes

- Updated dependencies [feb9236]
  - contentmap@0.1.0
