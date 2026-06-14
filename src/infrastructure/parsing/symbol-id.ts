/**
 * Canonical symbol-ID scheme (B4).
 *
 * Both the query path (`extract-symbols.ts`) and the fallback path
 * (`application/indexing/parsing/index.ts`) emit IDs through this single
 * function so the two paths produce comparable IDs. The column is INCLUDED so
 * two symbols on the same line do not collide (and get silently merged by
 * `deduplicateById`).
 *
 * This lives in the infrastructure layer so the query path can import it
 * without the layering violation that importing from `application/` would
 * cause. The application layer re-exports it for existing importers.
 */
export function generateSymbolId(
  filePath: string,
  name: string,
  startLine: number,
  startColumn: number,
): string {
  return `${filePath}:${name}:${startLine}:${startColumn}`;
}
