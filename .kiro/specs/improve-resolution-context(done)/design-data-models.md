# Resolution Context — Data Models & Algorithms

Part of the [Resolution Context Design](./design.md).

## Core Resolution Algorithm

### `resolveUncached(name, fromFile)`

```pascal
PROCEDURE resolveUncached(name: string, fromFile: string): TieredCandidates | null

  // ── Tier 1: Same-file ────────────────────────────────────────────────────
  localDef ← symbols.lookupExactFull(fromFile, name)
  IF localDef IS NOT NULL THEN
    RETURN { candidates: [localDef], tier: 'same-file' }
  END IF

  // ── Pre-fetch global candidates (shared by Tiers 2 and 3) ────────────────
  allDefs ← symbols.lookupFuzzy(name)

  // ── Tier 2a-named: Named binding chain ───────────────────────────────────
  // Must run BEFORE the allDefs.length === 0 early-return because aliased
  // imports mean lookupFuzzy('LocalAlias') returns [] while the chain
  // resolves to the exported name in the source file.
  chainResult ← walkBindingChain(name, fromFile, symbols, namedImportMap, allDefs)
  IF chainResult IS NOT NULL AND chainResult.length > 0 THEN
    RETURN { candidates: chainResult, tier: 'import-scoped' }
  END IF

  IF allDefs.length = 0 THEN
    RETURN null
  END IF

  // ── Tier 2a: Import-scoped ───────────────────────────────────────────────
  importedFiles ← importMap.get(fromFile)
  IF importedFiles IS NOT NULL THEN
    importedDefs ← allDefs WHERE def.filePath ∈ importedFiles
    IF importedDefs.length > 0 THEN
      RETURN { candidates: importedDefs, tier: 'import-scoped' }
    END IF
  END IF

  // ── Tier 2b: Package-scoped ──────────────────────────────────────────────
  importedPackages ← packageMap.get(fromFile)
  IF importedPackages IS NOT NULL THEN
    packageDefs ← allDefs WHERE isFileInPackageDir(def.filePath, dirSuffix)
                                FOR SOME dirSuffix ∈ importedPackages
    IF packageDefs.length > 0 THEN
      RETURN { candidates: packageDefs, tier: 'import-scoped' }
    END IF
  END IF

  // ── Tier 3: Global fallback ──────────────────────────────────────────────
  // Return ALL candidates. Consumers must check candidates.length.
  RETURN { candidates: allDefs, tier: 'global' }

END PROCEDURE
```

**Preconditions:**
- `name` is a non-empty string (symbol name from AST)
- `fromFile` is an absolute file path present in the symbol table

**Postconditions:**
- Returns `null` only when no candidates exist at any tier
- When non-null, `candidates.length >= 1`
- `tier` accurately reflects the winning resolution strategy
- No mutation of `symbols`, `importMap`, `packageMap`, or `namedImportMap`

**Loop invariants (Tier 2a filter):**
- All elements in `importedDefs` satisfy `importedFiles.has(def.filePath)`

---

### `resolve(name, fromFile)` — cache wrapper

```pascal
PROCEDURE resolve(name: string, fromFile: string): TieredCandidates | null

  // Cache hit path (only when cache is active AND file matches)
  IF cache IS NOT NULL AND cacheFile = fromFile THEN
    IF cache.has(name) THEN
      cacheHits ← cacheHits + 1
      RETURN cache.get(name)
    END IF
    cacheMisses ← cacheMisses + 1
  END IF

  result ← resolveUncached(name, fromFile)

  IF cache IS NOT NULL AND cacheFile = fromFile THEN
    cache.set(name, result)
  END IF

  RETURN result

END PROCEDURE
```

**Cache invariant:** `cache` only stores results for `cacheFile`. Switching files
via `enableCache(newFile)` clears all entries before the new file is processed.

---

### `walkBindingChain` algorithm

```pascal
PROCEDURE walkBindingChain(
  name: string,
  currentFilePath: string,
  symbolTable: SymbolTable,
  namedImportMap: NamedImportMap,
  allDefs: SymbolDefinition[]
): SymbolDefinition[] | null

  lookupFile ← currentFilePath
  lookupName ← name
  visited ← empty Set

  FOR depth FROM 0 TO 4 DO
    bindings ← namedImportMap.get(lookupFile)
    IF bindings IS NULL THEN RETURN null END IF

    binding ← bindings.get(lookupName)
    IF binding IS NULL THEN RETURN null END IF

    key ← binding.sourcePath + ':' + binding.exportedName
    IF key ∈ visited THEN RETURN null END IF  // circular reference
    visited.add(key)

    targetName ← binding.exportedName

    // Use pre-fetched allDefs at depth=0 for non-aliased names (avoids extra lookup)
    IF targetName ≠ lookupName OR depth > 0 THEN
      resolvedDefs ← symbolTable.lookupFuzzy(targetName)
                      WHERE def.filePath = binding.sourcePath
    ELSE
      resolvedDefs ← allDefs WHERE def.filePath = binding.sourcePath
    END IF

    IF resolvedDefs.length > 0 THEN RETURN resolvedDefs END IF

    // Definition not in source file — follow re-export chain
    lookupFile ← binding.sourcePath
    lookupName ← targetName
  END FOR

  RETURN null

END PROCEDURE
```

**Preconditions:**
- `allDefs` is the complete unfiltered `lookupFuzzy(name)` result
- `depth` limit of 5 prevents infinite loops

**Postconditions:**
- Returns `null` or a non-empty array
- Never returns an empty array

---

## Cache Lifecycle

```pascal
PROCEDURE enableCache(filePath: string): void
  cacheFile ← filePath
  IF cache IS NULL THEN
    cache ← new Map()
  ELSE
    cache.clear()   // reuse Map instance — reduces GC pressure at scale
  END IF
END PROCEDURE

PROCEDURE clearCache(): void
  cacheFile ← null
  cache?.clear()   // entries released; Map instance retained for reuse
END PROCEDURE
```

**Design note:** The Map instance is retained across `clearCache()` calls to avoid
repeated allocation/GC on large repos where `enableCache`/`clearCache` is called
once per file (potentially 100K+ times).

---

## `isFileInPackageDir` helper

Used by Tier 2b to check whether a definition's file path falls within a package
directory suffix:

```pascal
FUNCTION isFileInPackageDir(filePath: string, dirSuffix: string): boolean
  RETURN filePath.includes('/' + dirSuffix + '/') OR
         filePath.endsWith('/' + dirSuffix)
END FUNCTION
```

This is ported from the legacy `import-processor.ts`. It lives in `named-binding.ts`
alongside `walkBindingChain` to keep `resolution-context.ts` under 250 lines.
