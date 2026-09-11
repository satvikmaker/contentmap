import { DiagnosticBag } from './diagnostics/bag.ts'
import { renderDiagnostics } from './diagnostics/render.ts'
import type { BuildResult } from './types.ts'

/**
 * A build's diagnostics, rendered the way `contentmap build` prints them.
 * Empty when there is nothing to report.
 */
export function formatDiagnostics(result: BuildResult): string {
  if (result.diagnostics.length === 0) return ''
  const bag = new DiagnosticBag()
  for (const diagnostic of result.diagnostics) bag.add(diagnostic)
  return renderDiagnostics(bag, { total: result.scanned })
}

/**
 * What an integration throws when a production build has errors.
 *
 * `contentmap build` exits non-zero on the same result, so a framework build
 * going through an adapter has to fail too. Otherwise an invalid document
 * simply vanishes from the site, and the build reports success — the one
 * outcome this tool exists to prevent. The message carries the full report,
 * so whatever the framework prints on failure is what the CLI would have said.
 */
export class BuildFailedError extends Error {
  override readonly name = 'BuildFailedError'
  readonly result: BuildResult

  constructor(result: BuildResult) {
    const count = `${result.errors} error${result.errors === 1 ? '' : 's'}`
    super(`contentmap: the content build failed with ${count}.\n\n${formatDiagnostics(result)}`)
    this.result = result
  }
}
