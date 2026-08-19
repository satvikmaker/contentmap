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

export type Loader<T> = () => Promise<{ default: T }>

export interface Query<T, K extends keyof T = keyof T> {
  /** Narrow the projection. Chaining only ever narrows further. */
  select<S extends keyof T>(...keys: S[]): Query<T, Extract<S, K>>
  where(predicate: Partial<Pick<T, K>> | ((doc: Pick<T, K>) => boolean)): Query<T, K>
  sortBy<F extends K>(field: F, direction?: 'asc' | 'desc'): Query<T, K>
  limit(n: number): Query<T, K>
  skip(n: number): Query<T, K>
  groupBy<F extends K>(field: F): Map<T[F], Pick<T, K>[]>

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
  readonly modules: Record<string, Loader<T>>
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

function make<T, K extends keyof T>(state: State<T>): Query<T, K> {
  const q: Query<T, K> = {
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
      for (const row of project(state.rows, state.keys)) {
        const g = out.get(row[key])
        if (g) g.push(row)
        else out.set(row[key], [row])
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
  modules: Record<string, Loader<T>>
): Query<T> {
  return make<T, keyof T>({ index, modules, keys: null, rows: index })
}
