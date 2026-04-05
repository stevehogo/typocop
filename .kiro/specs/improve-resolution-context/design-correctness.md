# Resolution Context — Correctness Properties

Part of the [Resolution Context Design](./design.md).

## Property-Based Tests (fast-check)

All properties use `vitest` + `fast-check`. Test file: `src/indexer/resolution/resolution-context.test.ts`.

---

### Property RC-1: Non-null result has non-empty candidates

```
∀ name: string, fromFile: string, ctx: ResolutionContext
  ctx.resolve(name, fromFile) ≠ null
  ⟹ ctx.resolve(name, fromFile).candidates.length ≥ 1
```

**Test**: Generate arbitrary symbol tables and names. Assert that whenever `resolve` returns non-null, `candidates` is non-empty.

---

### Property RC-2: Tier 1 returns exactly one candidate

```
∀ sym: SymbolDefinition in symbolTable at (filePath, name)
  ctx.resolve(name, filePath).tier = 'same-file'
  ∧ ctx.resolve(name, filePath).candidates = [sym]
```

**Test**: Add a symbol to the table, resolve from the same file. Assert `tier === 'same-file'` and `candidates.length === 1`.

---

### Property RC-3: Tier 2a candidates are all in importMap[fromFile]

```
∀ result where result.tier = 'import-scoped' (via importMap path)
  ∀ def ∈ result.candidates
    def.filePath ∈ importMap.get(fromFile)
```

**Test**: Populate importMap with a known set of files. Assert all returned candidates at import-scoped tier have filePaths in that set.

---

### Property RC-4: Tier 3 returns all lookupFuzzy candidates

```
∀ name where importMap.get(fromFile) = undefined
           ∧ packageMap.get(fromFile) = undefined
           ∧ namedImportMap.get(fromFile) = undefined
  ctx.resolve(name, fromFile).candidates = symbolTable.lookupFuzzy(name)
```

**Test**: Resolve a name with no import maps populated. Assert candidates equal the full fuzzy lookup result.

---

### Property RC-5: Cache hit returns identical result to uncached

```
∀ name, fromFile
  let r1 = ctx.resolve(name, fromFile)          // uncached
  ctx.enableCache(fromFile)
  let r2 = ctx.resolve(name, fromFile)          // cache miss — populates cache
  let r3 = ctx.resolve(name, fromFile)          // cache hit
  r1 deep-equals r2 ∧ r2 deep-equals r3
```

**Test**: Resolve the same name three times (before cache, first cached call, second cached call). Assert all three results are deeply equal.

---

### Property RC-6: cacheHits + cacheMisses = total calls when cache active

```
∀ names: string[], fromFile: string
  ctx.enableCache(fromFile)
  resolve each name once → N calls, all misses
  resolve each name again → N calls, all hits
  getStats().cacheHits = N
  getStats().cacheMisses = N
```

**Test**: Generate a list of N distinct names, resolve each twice with cache enabled. Assert hits = N, misses = N.

---

### Property RC-7: resolve() never mutates the symbol table

```
∀ name, fromFile
  let statsBefore = ctx.symbols.getStats()
  ctx.resolve(name, fromFile)
  ctx.symbols.getStats() deep-equals statsBefore
```

**Test**: Property over arbitrary names. Assert `getStats()` is unchanged after any number of `resolve()` calls.

---

## Example-Based Tests

### Example RC-E1: TIER_CONFIDENCE values

```typescript
expect(TIER_CONFIDENCE['same-file']).toBe(0.95);
expect(TIER_CONFIDENCE['import-scoped']).toBe(0.90);
expect(TIER_CONFIDENCE['global']).toBe(0.50);
```

### Example RC-E2: Named binding chain (Tier 2a-named)

Setup: File A imports `{ User }` from B. B re-exports `{ User }` from C. C defines `User`.
Assert: `resolve('User', fileA).tier === 'import-scoped'` and candidate is from C.

### Example RC-E3: Circular binding chain returns null

Setup: A→B→A in `namedImportMap`.
Assert: `resolve('X', fileA) === null`.

### Example RC-E4: Chain depth > 5 returns null

Setup: Chain A→B→C→D→E→F (depth 6).
Assert: `resolve('X', fileA) === null`.

### Example RC-E5: clear() resets all state

After populating symbols, importMap, packageMap, namedImportMap, and calling `clear()`:
- `getStats()` returns `{ fileCount: 0, globalSymbolCount: 0, cacheHits: 0, cacheMisses: 0 }`
- `resolve('anything', 'any/file.ts')` returns `null`

### Example RC-E6: enableCache switches file correctly

```
enableCache('a.ts') → resolve('X', 'a.ts') → miss
enableCache('b.ts') → resolve('X', 'b.ts') → miss (new file, cache cleared)
resolve('X', 'a.ts') → NOT a cache hit (wrong file)
```

### Example RC-E7: Tier 2b package-scoped resolution

Setup: `packageMap.get('src/app.ts')` returns `Set(['models'])`. Symbol `User` defined in `src/models/user.ts`.
Assert: `resolve('User', 'src/app.ts').tier === 'import-scoped'` and candidate is `User` from `src/models/user.ts`.
