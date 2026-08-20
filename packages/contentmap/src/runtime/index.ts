/**
 * The only contentmap code that ships into an application bundle.
 *
 * Constraints, all deliberate:
 *  - zero dependencies, tree-shakeable, target < 1KB minzipped
 *  - no `eval`, no `Function`, no `Proxy` — must run under a strict CSP and on
 *    React Native, which is where all three incumbents' MDX output fails
 *  - chainable methods return a view over the same backing array; nothing is
 *    copied until a terminal method
 *  - `load()` is the ONLY method that triggers a dynamic import
 */

/** A lazily imported document module, as the generated index emits it. */
export type ModuleLoader<T> = () => Promise<{ default: T }>

/**
 * `K` is what a row will be projected to; `I` is what the index actually
 * holds, and never narrows.
 *
 * Keeping them apart is what lets you select the two fields you render and
 * still sort by a third. Chaining `select` does not drop anything at the
 * time — projection happens once, at the terminal call — so restricting
 * `sortBy` to the projection forbade something the runtime does correctly.
 * "Give me title and slug, newest first" is the ordinary way to ask, and it
 * failed to compile.
 *
 * `I` defaults to `K`, so `Query<Post, keyof PostIndex>` as the generated
 * index emits it keeps meaning exactly what it did.
 */
export interface Query<T, K extends keyof T = keyof T, I extends keyof T = K> {
  /** Narrow the projection. Chaining only ever narrows further. */
  select<S extends keyof T>(...keys: S[]): Query<T, Extract<S, K>, I>
  where(predicate: Partial<Pick<T, I>> | ((doc: Pick<T, I>) => boolean)): Query<T, K, I>
  sortBy<F extends I>(field: F, direction?: 'asc' | 'desc'): Query<T, K, I>
  limit(n: number): Query<T, K, I>
  skip(n: number): Query<T, K, I>
  groupBy<F extends I>(field: F): Map<T[F], Pick<T, K>[]>

  all(): Pick<T, K>[]
  first(): Pick<T, K> | undefined
  count(): number
  ids(): string[]

  /** Full document including heavy fields. Bundles ONE document. */
  load(id: string): Promise<T>
  loadAll(): Promise<T[]>
}

interface State<T> {
  readonly index: readonly Record<string, unknown>[]
  readonly modules: Record<string, ModuleLoader<T>>
  readonly keys: readonly string[] | null
  readonly rows: readonly Record<string, unknown>[]
}

function project(
  rows: readonly Record<string, unknown>[],
  keys: readonly string[] | null
): Record<string, unknown>[] {
  if (!keys) return rows as Record<string, unknown>[]
  const out: Record<string, unknown>[] = []
  for (const row of rows) {
    // `_meta` is always carried: it holds identity, so dropping it would break
    // load()/ids() on a projected query.
    const picked: Record<string, unknown> = { _meta: row['_meta'] }
    for (const k of keys) if (k in row) picked[k] = row[k]
    out.push(picked)
  }
  return out
}

/** Identity lives in `_meta.id`; there is no synthetic top-level `id` field. */
function idOf(row: Record<string, unknown>): string {
  return (row['_meta'] as { id: string }).id
}

function make<T, K extends keyof T, I extends keyof T>(state: State<T>): Query<T, K, I> {
  const q: Query<T, K, I> = {
    select(...next) {
      const keys = state.keys ? state.keys.filter(k => (next as string[]).includes(k)) : (next as string[])
      return make({ ...state, keys })
    },
    where(predicate) {
      const rows =
        typeof predicate === 'function'
          ? state.rows.filter(r => (predicate as (d: unknown) => boolean)(r))
          : state.rows.filter(r => {
              for (const [k, v] of Object.entries(predicate as Record<string, unknown>)) {
                if (r[k] !== v) return false
              }
              return true
            })
      return make({ ...state, rows })
    },
    sortBy(field, direction = 'asc') {
      const key = field as unknown as string
      const sign = direction === 'desc' ? -1 : 1
      const rows = [...state.rows].sort((a, b) => {
        const x = a[key]
        const y = b[key]
        if (x === y) return 0
        if (x === undefined || x === null) return 1
        if (y === undefined || y === null) return -1
        return (x < y ? -1 : 1) * sign
      })
      return make({ ...state, rows })
    },
    limit(n) {
      return make({ ...state, rows: state.rows.slice(0, Math.max(0, n)) })
    },
    skip(n) {
      return make({ ...state, rows: state.rows.slice(Math.max(0, n)) })
    },
    groupBy(field) {
      const key = field as unknown as string
      const out = new Map<unknown, Record<string, unknown>[]>()
      // Group on the unprojected row, collect the projected one. Reading the
      // key after projection put every row in a single `undefined` group
      // whenever the field was not selected — a wrong answer rather than an
      // error, which is the worst kind.
      const rows = project(state.rows, state.keys)
      for (let i = 0; i < rows.length; i++) {
        const g = out.get(state.rows[i]![key])
        if (g) g.push(rows[i]!)
        else out.set(state.rows[i]![key], [rows[i]!])
      }
      return out as Map<T[typeof field], Pick<T, K>[]>
    },
    all() {
      return project(state.rows, state.keys) as Pick<T, K>[]
    },
    first() {
      const [row] = state.rows
      return row === undefined ? undefined : (project([row], state.keys)[0] as Pick<T, K>)
    },
    count() {
      return state.rows.length
    },
    ids() {
      return state.rows.map(idOf)
    },
    async load(id) {
      const loader = state.modules[id]
      if (loader) return (await loader()).default
      // `bundle` output inlines whole documents into the index instead of
      // emitting a module per document, so resolve from there. Keeping one
      // Query surface across both formats is why this fallback exists.
      const row = state.index.find(r => idOf(r) === id)
      if (row) return row as T
      throw new Error(`contentmap: no document with id "${id}"`)
    },
    async loadAll() {
      return Promise.all(state.rows.map(row => q.load(idOf(row))))
    }
  }
  return q
}

/** Called by generated code. Not intended for direct use. */
export function collection<T>(
  index: readonly Record<string, unknown>[],
  modules: Record<string, ModuleLoader<T>>
): Query<T> {
  return make<T, keyof T, keyof T>({ index, modules, keys: null, rows: index })
}
