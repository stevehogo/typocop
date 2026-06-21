/**
 * Parse-cache schema/extraction version (A2).
 *
 * BUMP this whenever the parse output shape changes in a way that invalidates
 * cached entries — e.g. new tree-sitter grammar versions, changed symbol/hint
 * extraction logic, or a new `Symbol`/hint field. The parse-cache classifier
 * (`application/indexing/cache/classify.ts`) treats any cached entry whose
 * `parseVersion` differs from this constant as STALE (re-parse), giving a
 * whole-cache invalidation on upgrade without an explicit `--refresh`.
 *
 * History:
 *   1 → 2  Wave 1: `import` hints now carry optional `namedBindings`. Unchanged
 *          files must re-emit so the now-populated import maps take effect on a
 *          warm cache (cross-cutting-checklist §0).
 *   2 → 3  Wave 2: `Symbol` now carries an optional `isExported` (per-language
 *          export detection) and the parameter-count now uses variadic-aware
 *          signature extraction. Unchanged files must re-emit so the new field /
 *          corrected arity populate on a warm cache.
 */
export const PARSE_VERSION = 3;
