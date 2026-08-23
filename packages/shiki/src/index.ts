import {
  createHighlighter,
  type BundledLanguage,
  type BundledTheme,
  type ShikiTransformer
} from 'shiki'
import type { MarkedExtension } from 'marked'

export interface ShikiOptions {
  /**
   * A single theme, or a light/dark pair.
   *
   * A pair emits CSS variables rather than inline colours, so the page can
   * switch without re-highlighting — which a build-time highlighter otherwise
   * cannot do, having already committed to one palette.
   */
  theme?: BundledTheme | { light: BundledTheme; dark: BundledTheme }
  /**
   * Languages to load.
   *
   * Every language is a grammar that has to be parsed and held in memory, so
   * this is a list rather than "all of them". A fence whose language is not
   * loaded is rendered as plain text rather than failing the build.
   */
  langs?: readonly BundledLanguage[]
  /** Shiki transformers, e.g. from `@shikijs/transformers`. */
  transformers?: readonly ShikiTransformer[]
  /**
   * Language for a fence that declares none. Default `'text'`, which is
   * highlighted as plain text rather than guessed at.
   */
  defaultLanguage?: BundledLanguage | 'text'
}

const DEFAULT_LANGS: readonly BundledLanguage[] = [
  'bash',
  'css',
  'html',
  'javascript',
  'json',
  'jsx',
  'markdown',
  'python',
  'sh',
  'tsx',
  'typescript',
  'yaml'
]

/**
 * Syntax highlighting for the default markdown renderer.
 *
 * Returns a marked extension, so it goes through the renderer's existing
 * `extensions` option and neither package needs to know about the other:
 *
 * ```ts
 * renderer: markdown({ extensions: [await shiki({ theme: 'github-dark' })] })
 * ```
 *
 * Async because Shiki loads grammars up front. That is deliberate — once
 * loaded, highlighting is synchronous, which is what lets it sit inside
 * marked's synchronous pipeline at all.
 *
 * Using `@contentmap/unified` instead? Pass `@shikijs/rehype` in
 * `rehypePlugins`; it already has a home there and this package would only be
 * in the way.
 */
export async function shiki(options: ShikiOptions = {}): Promise<MarkedExtension> {
  const theme = options.theme ?? 'github-dark'
  const dual = typeof theme === 'object'
  const langs = [...(options.langs ?? DEFAULT_LANGS)]
  const fallback = options.defaultLanguage ?? 'text'

  const highlighter = await createHighlighter({
    themes: dual ? [theme.light, theme.dark] : [theme],
    langs
  })

  const loaded = new Set(highlighter.getLoadedLanguages())

  // Checked once, here, rather than on the first fence that needs it. Shiki
  // throws "Language `x` not found" from inside codeToHtml, which surfaces
  // mid-build against whichever document happened to have a bare fence — and
  // the whole purpose of a fallback is to be the thing that cannot fail.
  if (fallback !== 'text' && !loaded.has(fallback)) {
    throw new Error(
      `@contentmap/shiki: defaultLanguage "${fallback}" is not loaded. ` +
        `Add it to \`langs\`, or leave defaultLanguage unset to render bare fences as plain text.`
    )
  }

  return {
    renderer: {
      code({ text, lang }): string {
        // An unknown language is rendered, not rejected. A fence saying
        // ```mermaid in a corpus of a thousand documents should not fail a
        // build over a missing grammar.
        // ```ts twoslash {1,3} — the first word is the language, the rest is
        // metadata. Transformers read it for line highlighting, diff markers
        // and the like, so dropping it makes the `transformers` option far
        // less useful than it looks.
        // Split on whitespace or the first `{`. VitePress and others write
        // ```js{1,3} with no space, and treating that as a language name means
        // the block silently loses its highlighting. No language name contains
        // a brace, so this cannot split one by mistake.
        const info = (lang ?? '').trim()
        const separator = info.search(/[\s{]/)
        const requested = separator === -1 ? info : info.slice(0, separator)
        const raw = separator === -1 ? '' : info.slice(separator).trim()
        const language = loaded.has(requested) ? requested : fallback

        return highlighter.codeToHtml(text, {
          lang: language,
          ...(dual
            ? { themes: { light: theme.light, dark: theme.dark } }
            : { theme: theme as BundledTheme }),
          ...(options.transformers ? { transformers: [...options.transformers] } : {}),
          ...(raw === '' ? {} : { meta: { __raw: raw } })
        })
      }
    }
  }
}

export default shiki
