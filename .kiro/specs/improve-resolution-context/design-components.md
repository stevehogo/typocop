# Resolution Context — Components & Interfaces

Part of the [Resolution Context Design](./design.md).

## Exported Types

### `ResolutionTier`

```typescript
export type ResolutionTier = 'same-file' | 'import-scoped' | 'global';
```

Maps to the winning tier for a given resolution. Tiers 2a-named, 2a, and 2b all
report as `'import-scoped'` — the internal sub-tier distinction is not exposed.

---

### `TieredCandidates`

```typescript
export interface TieredCandidates {
  readonly candidates: readonly SymbolDefinition[];
  readonly tier: ResolutionTier;
}
```

Returned by `resolve()`. `candidates` is always non-empty when the result is
non-null. At Tier 1 it contains exactly one entry. At Tier 3 it may contain
many — consumers must check `candidates.length` and refuse ambiguous matches.

---

### `TIER_CONFIDENCE`

```typescript
export const TIER_CONFIDENCE: Record<ResolutionTier, number> = {
  'same-file':     0.95,
  'import-scoped': 0.90,
  'global':        0.50,
};
```

Consumers multiply their base confidence by `TIER_CONFIDENCE[result.tier]` when
building `Relationship` metadata or `QueryResult.confidence`.

---

### Map type aliases

```typescript
export type ImportMap     = Map<string, Set<string>>;   // fromFile → Set<importedFilePath>
export type PackageMap    = Map<string, Set<string>>;   // fromFile → Set<packageDirSuffix>
export type NamedImportMap = Map<string, Map<string, NamedImportBinding>>;
                                                        // fromFile → localName → binding
```

`NamedImportBinding` is defined in `named-binding.ts`:

```typescript
export interface NamedImportBinding {
  readonly sourcePath: string;    // absolute path of the exporting file
  readonly exportedName: string;  // name as exported by sourcePath
}
```

---

### `ResolutionContext`

```typescript
export interface ResolutionContext {
  /**
   * Resolve a name used in fromFile to its definition(s).
   * Returns null when no candidates exist at any tier.
   * Tier 3 ('global') returns ALL candidates — consumers must check count.
   */
  resolve(name: string, fromFile: string): TieredCandidates | null;

  // ── Data access (pipeline wiring only — not for resolution) ──────────────
  readonly symbols: SymbolTable;
  readonly importMap: ImportMap;
  readonly packageMap: PackageMap;
  readonly namedImportMap: NamedImportMap;

  // ── Per-file cache lifecycle ──────────────────────────────────────────────
  /** Activate cache for filePath. Clears any previous cache entries. */
  enableCache(filePath: string): void;
  /** Deactivate cache and release entries (reuses Map instance to reduce GC). */
  clearCache(): void;

  // ── Operational ──────────────────────────────────────────────────────────
  getStats(): ResolutionStats;
  /** Full reset — clears symbol table, all maps, cache, and counters. */
  clear(): void;
}
```

---

### `ResolutionStats`

```typescript
export interface ResolutionStats {
  readonly fileCount: number;
  readonly globalSymbolCount: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
}
```

---

## `named-binding.ts` — `walkBindingChain`

```typescript
/**
 * Follow a named-import re-export chain through namedImportMap.
 *
 * When file A imports { User } from B, and B re-exports { User } from C,
 * this function walks A→B→C until a SymbolDefinition is found.
 *
 * @param allDefs  Complete unfiltered lookupFuzzy(name) result.
 *                 Must NOT be pre-filtered — silent misses occur otherwise.
 * @returns        Matching definitions, or null if chain breaks / depth exceeded.
 */
export function walkBindingChain(
  name: string,
  currentFilePath: string,
  symbolTable: SymbolTable,
  namedImportMap: NamedImportMap,
  allDefs: SymbolDefinition[],
): SymbolDefinition[] | null
```

Max chain depth: 5. Circular references detected via a `visited` Set keyed on
`sourcePath:exportedName`.

---

## `createResolutionContext` factory

```typescript
export function createResolutionContext(): ResolutionContext
```

Returns a fresh `ResolutionContext`. All state is closure-private. The returned
object exposes the public maps as mutable references so the pipeline can populate
them directly — this is intentional (same pattern as the legacy implementation).

The internal `SymbolTable` is created via `createSymbolTable()` from `symbol-table.ts`
(already fully implemented). Symbols are added via `symbols.add(filePath, name, nodeId, type)`.
`lookupExact` returns `string | undefined` (the `nodeId`); `lookupExactFull` returns
`SymbolDefinition | undefined`; `lookupFuzzy` returns `SymbolDefinition[]`.

### Internal state

| Variable | Type | Purpose |
|----------|------|---------|
| `symbols` | `SymbolTable` | Two-index symbol store (via `createSymbolTable()`) |
| `importMap` | `ImportMap` | Per-file direct import paths |
| `packageMap` | `PackageMap` | Per-file package dir suffixes |
| `namedImportMap` | `NamedImportMap` | Per-file named binding chains |
| `cacheFile` | `string \| null` | Currently cached file path |
| `cache` | `Map<string, TieredCandidates \| null> \| null` | Resolution cache |
| `cacheHits` | `number` | Monotonically increasing counter |
| `cacheMisses` | `number` | Monotonically increasing counter |
