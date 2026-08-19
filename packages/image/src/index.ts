import { imageSize } from 'image-size'
import { rgbaToThumbHash, thumbHashToDataURL, thumbHashToAverageRGBA } from 'thumbhash'
import type { ImageMeasurement, ImagePlaceholder, ImageProcessor } from 'contentmap'

export interface ImageOptions {
  /**
   * Generate a placeholder. Requires `sharp`, which is an optional dependency:
   * without it, dimensions still work and the placeholder is simply absent.
   * Default true.
   */
  placeholder?: boolean
  /** Longest edge of the image decoded for the hash. Default 100. */
  sampleSize?: number
}

/**
 * Dimensions via image-size, placeholders via thumbhash.
 *
 * image-size is one package with no dependencies and reads only a capped head
 * slice of the file, so measuring a corpus never loads it into memory. sharp is
 * 28.6 MB and ships an unused wasm build on every platform, which is why it is
 * optional and used solely to decode pixels for the hash.
 *
 * thumbhash over blurhash: the payload is 21 bytes, `thumbHashToDataURL`
 * reconstitutes a PNG data URI at BUILD time so the client ships no decoder at
 * all, and it carries alpha and an average colour for free.
 */
export function image(options: ImageOptions = {}): ImageProcessor {
  const wantPlaceholder = options.placeholder ?? true
  const sampleSize = options.sampleSize ?? 100
  let decoder: Decoder | null | undefined

  return {
    name: 'image-size+thumbhash',

    measure(buffer: Uint8Array): ImageMeasurement | undefined {
      try {
        const size = imageSize(buffer)
        if (!size.width || !size.height) return undefined
        return { width: size.width, height: size.height, format: size.type ?? 'unknown' }
      } catch {
        // Not a decodable image, or a format image-size does not know. The
        // asset is still copied; it just carries no dimensions.
        return undefined
      }
    },

    async placeholder(buffer: Uint8Array): Promise<ImagePlaceholder | undefined> {
      if (!wantPlaceholder) return undefined
      decoder ??= await loadDecoder()
      if (!decoder) return undefined
      try {
        const raw = await decoder(buffer, sampleSize)
        if (!raw) return undefined
        const hash = rgbaToThumbHash(raw.width, raw.height, raw.data)
        const { r, g, b, a } = thumbHashToAverageRGBA(hash)
        return {
          dataUri: thumbHashToDataURL(hash),
          color: toHex(r, g, b),
          opaque: a >= 0.99
        }
      } catch {
        return undefined
      }
    }
  }
}

type Decoder = (
  buffer: Uint8Array,
  sampleSize: number
) => Promise<{ width: number; height: number; data: Uint8Array } | undefined>

/**
 * Load sharp if it is installed.
 *
 * `npm i --omit=optional` is a supported deployment, and so is any platform
 * sharp has no binary for. Both must degrade to "no placeholder", never to a
 * failed build.
 */
async function loadDecoder(): Promise<Decoder | null> {
  try {
    const sharp = (await import('sharp')).default
    return async (buffer, sampleSize) => {
      // thumbhash requires at most 100x100.
      const { data, info } = await sharp(buffer)
        .resize(sampleSize, sampleSize, { fit: 'inside', withoutEnlargement: true })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      return { width: info.width, height: info.height, data: new Uint8Array(data) }
    }
  } catch {
    return null
  }
}

function toHex(r: number, g: number, b: number): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value * 255)))
      .toString(16)
      .padStart(2, '0')
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

export default image
