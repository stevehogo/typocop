/**
 * Parse-cache schema/extraction version (A2).
 *
 * BUMP this whenever the parse output shape changes in a way that invalidates
 * cached entries — e.g. new tree-sitter grammar versions, changed symbol/hint
 * extraction logic, or a new `Symbol`/hint field. The parse-cache classifier
 * (`application/indexing/cache/classify.ts`) treats any cached entry whose
 * `parseVersion` differs from this constant as STALE (re-parse), giving a
 * whole-cache invalidation on upgrade without an explicit `--refresh`.
 */
export const PARSE_VERSION = 1;
