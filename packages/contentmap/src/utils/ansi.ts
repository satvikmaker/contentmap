/**
 * Minimal ANSI styling. No `chalk`/`picocolors` dependency — velite proved this
 * costs nothing, and colour is not worth a package.
 */
const ESC = '\x1b['

const enabled: boolean =
  process.env['NO_COLOR'] === undefined &&
  process.env['FORCE_COLOR'] !== '0' &&
  (process.env['FORCE_COLOR'] !== undefined || process.stdout.isTTY === true)

const wrap =
  (open: number, close: number) =>
  (s: string): string =>
    enabled ? `${ESC}${open}m${s}${ESC}${close}m` : s

export const bold: (s: string) => string = wrap(1, 22)
export const dim: (s: string) => string = wrap(2, 22)
export const red: (s: string) => string = wrap(31, 39)
export const green: (s: string) => string = wrap(32, 39)
export const yellow: (s: string) => string = wrap(33, 39)
export const blue: (s: string) => string = wrap(34, 39)
export const cyan: (s: string) => string = wrap(36, 39)
export const gray: (s: string) => string = wrap(90, 39)

export const colorEnabled: boolean = enabled
