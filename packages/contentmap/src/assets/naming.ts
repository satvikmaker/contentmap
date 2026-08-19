import { basename, extname } from 'node:path'

/**
 * Extensions treated as copyable assets.
 *
 * An allowlist, not a denylist, and that direction is the whole point. Velite
 * feeds ANY relative href to its asset pipeline, so a plain cross-document link
 * like `[see](./other.md)` becomes readFile -> ENOENT -> fatal, and the entire
 * record is dropped. Every markdown-to-markdown link in a corpus is a build
 * breaker. Anything not listed here is left exactly as the author wrote it.
 */
export const DEFAULT_ASSET_EXTENSIONS: readonly string[] = [
  // images
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.bmp', '.tif', '.tiff',
  // media
  '.mp4', '.webm', '.ogv', '.mp3', '.wav', '.m4a', '.oga', '.mov',
  // documents and archives
  '.pdf', '.zip', '.csv', '.txt',
  // fonts
  '.woff', '.woff2', '.ttf', '.otf'
]

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.bmp', '.tif', '.tiff'
])

export function isImageExtension(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext.toLowerCase())
}

const ABSOLUTE_URL = /^[a-zA-Z][a-zA-Z\d+\-.]*:/
const ABSOLUTE_PATH = /^(\/[^/\\]|\/$|[a-zA-Z]:[\\/])/

/**
 * Is this a path we should resolve against the referring file?
 *
 * Anchors, queries, protocol-relative and absolute URLs, and rooted paths are
 * all the author addressing something we do not own.
 */
export function isRelativeUrl(url: string): boolean {
  if (url === '') return false
  if (url.startsWith('#') || url.startsWith('?')) return false
  if (url.startsWith('//')) return false
  if (ABSOLUTE_URL.test(url)) return false
  if (ABSOLUTE_PATH.test(url)) return false
  return true
}

export interface SplitUrl {
  /** Path with any ?query and #hash removed. */
  path: string
  /** The ?query#hash tail, preserved onto the rewritten URL. */
  suffix: string
}

export function splitUrl(url: string): SplitUrl {
  const query = url.indexOf('?')
  const hash = url.indexOf('#')
  const cut = Math.min(query === -1 ? Infinity : query, hash === -1 ? Infinity : hash)
  return cut === Infinity
    ? { path: url, suffix: '' }
    : { path: url.slice(0, cut), suffix: url.slice(cut) }
}

/**
 * Expand `[name]-[hash:8].[ext]` against a source path and its content digest.
 *
 * Content-addressed so the URL is immutable and cacheable forever, and so two
 * identical files under different names still produce distinct entries the
 * copier can dedupe.
 */
export function expandTemplate(
  template: string,
  sourcePath: string,
  digest: string
): string {
  const ext = extname(sourcePath)
  const stem = basename(sourcePath, ext)
  return template.replace(
    /\[(name|hash|ext)(?::(\d+))?\]/g,
    (whole, key: string, lengthRaw: string | undefined) => {
      const length = lengthRaw === undefined ? undefined : Number(lengthRaw)
      switch (key) {
        case 'name':
          return sanitize(length === undefined ? stem : stem.slice(0, length))
        case 'hash':
          return length === undefined ? digest : digest.slice(0, length)
        case 'ext':
          return (length === undefined ? ext.slice(1) : ext.slice(1, 1 + length)).toLowerCase()
        default:
          return whole
      }
    }
  )
}

/** Keep emitted filenames URL-safe and portable across filesystems. */
function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'asset'
}

/** Join a base URL and a filename without doubling or dropping the slash. */
export function joinUrl(base: string, name: string): string {
  return base.endsWith('/') ? base + name : `${base}/${name}`
}
