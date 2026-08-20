/** Which tool a config was written for. */
export type SourceTool = 'contentlayer2' | 'velite' | 'content-collections'

export type NoteKind =
  /** Converted, but the result is a guess worth reading. */
  | 'review'
  /** Carried over verbatim because it is arbitrary code. */
  | 'manual'
  /** contentmap has no equivalent. */
  | 'unsupported'

export interface Note {
  kind: NoteKind
  /** Collection the note belongs to, when it is not config-wide. */
  collection?: string
  /** The construct being reported on, e.g. `computedFields.slug`. */
  subject: string
  message: string
  /** What to do about it. */
  hint?: string
}

export interface MigrationResult {
  tool: SourceTool
  /** The generated contentmap.config.ts. */
  config: string
  /** Collections that were translated, in source order. */
  collections: string[]
  notes: Note[]
  /** Packages the generated config needs. */
  install: string[]
}

/**
 * A field in the shape contentmap wants it.
 *
 * `expression` is emitted verbatim, so a translator can hand back either
 * something it built (`z.string()`) or something it lifted unchanged out of the
 * source.
 */
export interface Field {
  name: string
  expression: string
}
