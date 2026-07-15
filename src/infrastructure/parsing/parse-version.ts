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
 *   3 → 4  Wave 3 (Tier B): `call` hints may now carry an optional `receiverType`
 *          (the AST type-env's resolved receiver type name). Unchanged files must
 *          re-emit so warm-cache hints carry it when the Tier-B flag is on
 *          (cross-cutting-checklist §0–§1). When the flag is OFF the field is
 *          never populated, so this bump is the only on-the-wire change.
 *   4 → 5  Wave 5 (data-touch): `Symbol` now carries an optional `synthetic`
 *          boolean (set on the data-touch pass's minted DB-model / API-endpoint
 *          anchor Symbols). Although the data-touch pass itself is a
 *          post-Phase-2 whole-corpus mutation (not parse-cached, like Tier A1),
 *          the new `Symbol` field is part of the cached per-file `Symbol[]` shape
 *          (`CachedFileEntry.symbols` stores Symbols as JSON), so a warm cache
 *          must re-emit to stay shape-consistent (cross-cutting-checklist §0).
 *   5 → 6  Wave 4 (call-resolution precision): `call` hints may now carry optional
 *          `argCount` (direct argument count, `undefined` when not cheaply
 *          countable) and `callForm` (`free`/`member`/`constructor`). The
 *          resolver reads them for callable-kind / arity / receiver-type
 *          filtering, so unchanged files must re-emit to carry them on a warm
 *          cache (cross-cutting-checklist §0–§1). The fields are additive and the
 *          Task-5 refuse-on-ambiguity behaviour is flag-gated default-OFF, so when
 *          the flag is off this bump is the only on-the-wire change.
 *   6 → 7  Wave 6 (framework extraction): the cached per-file entry now carries
 *          optional `routes` / `eventSubscribers` arrays, route-handler Symbols
 *          may carry `responseKeys`, and Magento2 XML symbols are folded in.
 *          The framework pass is flag-gated default-OFF
 *          (`TYPOCOP_FRAMEWORK_EXTRACTION`), but the cached entry SHAPE changed
 *          (new optional cache fields), so a warm cache must re-emit to stay
 *          shape-consistent and to pick up framework records once the flag is on
 *          (cross-cutting-checklist §0). When the flag is off this bump is the
 *          only on-the-wire change.
 *   7 → 8  Wave 7 (§3.1, Task 4): heritage hints may now carry an optional
 *          `heritageKind` (`embed`/`include`/`extend`/`prepend`) and, when the
 *          Wave-7 flag (`TYPOCOP_HERITAGE_DISAMBIGUATION`) is on in Phase 2, the
 *          Go heritage emission skips NAMED struct fields and Ruby
 *          `include`/`extend`/`prepend` mixins are emitted as `implements`
 *          heritage. The flag is default-OFF (byte-identical when off), but the
 *          cached per-file hint SHAPE changed (new optional field) AND the
 *          Phase-2 emission differs once the flag is on, so a warm cache must
 *          re-emit to stay shape-consistent and to pick up the new heritage edges
 *          when the flag is on (cross-cutting-checklist §0–§1). When the flag is
 *          off this bump is the only on-the-wire change.
 *
 * NOT bumped for Wave 3 Tier A1 (TS-compiler-API receiver types): A1 reuses the
 * existing `receiverType` field and runs as a post-Phase-2, whole-corpus pass on
 * the MERGED hints in `pipeline.ts` — it overrides `receiverType` AFTER the
 * per-file cache snapshot is built (`runPhase2` caches the pre-enrichment hints),
 * so it re-runs on warm-cache files every run with no cache plumbing. No new
 * cached/persisted field, so no bump is required (cross-cutting-checklist §0–§1).
 */
export const PARSE_VERSION = 8;
