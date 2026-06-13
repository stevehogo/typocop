/**
 * Resolution Context — 4-tier symbol resolution with per-file cache.
 *
 * Tier 1: same-file (confidence 0.95)
 * Tier 2a-named: named binding chain (confidence 0.90)
 * Tier 2a: import-scoped (confidence 0.90)
 * Tier 2b: package-scoped (confidence 0.90)
 * Tier 3: global fallback (confidence 0.50)
 */
import { createSymbolTable } from "./symbol-table.js";
import { walkBindingChain, isFileInPackageDir } from "./named-binding.js";
import type { SymbolTable, SymbolDefinition } from "./symbol-table.js";
import type { NamedImportMap } from "./named-binding.js";

export type { NamedImportMap };
export type ImportMap  = Map<string, Set<string>>;  // fromFile → Set<importedFilePath>
export type PackageMap = Map<string, Set<string>>;  // fromFile → Set<packageDirSuffix>

export type ResolutionTier = "same-file" | "import-scoped" | "global";

export interface TieredCandidates {
  readonly candidates: readonly SymbolDefinition[];
  readonly tier: ResolutionTier;
}

export interface ResolutionStats {
  readonly fileCount: number;
  readonly globalSymbolCount: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
}

export const TIER_CONFIDENCE: Record<ResolutionTier, number> = {
  "same-file":     0.95,
  "import-scoped": 0.90,
  "global":        0.50,
};

export interface ResolutionContext {
  resolve(name: string, fromFile: string): TieredCandidates | null;

  readonly symbols: SymbolTable;
  readonly importMap: ImportMap;
  readonly packageMap: PackageMap;
  readonly namedImportMap: NamedImportMap;

  enableCache(filePath: string): void;
  clearCache(): void;

  getStats(): ResolutionStats;
  clear(): void;
}

export function createResolutionContext(): ResolutionContext {
  const symbols = createSymbolTable();
  const importMap: ImportMap = new Map();
  const packageMap: PackageMap = new Map();
  const namedImportMap: NamedImportMap = new Map();

  let cacheFile: string | null = null;
  let cache: Map<string, TieredCandidates | null> | null = null;
  let cacheHits = 0;
  let cacheMisses = 0;

  function resolveUncached(name: string, fromFile: string): TieredCandidates | null {
    // Tier 1: same-file
    const localDef = symbols.lookupExactFull(fromFile, name);
    if (localDef) return { candidates: [localDef], tier: "same-file" };

    const allDefs = symbols.lookupFuzzy(name);

    // Tier 2a-named: named binding chain (runs before allDefs.length check)
    const chainResult = walkBindingChain(name, fromFile, symbols, namedImportMap, allDefs);
    if (chainResult && chainResult.length > 0) {
      return { candidates: chainResult, tier: "import-scoped" };
    }

    if (allDefs.length === 0) return null;

    // Tier 2a: import-scoped
    const importedFiles = importMap.get(fromFile);
    if (importedFiles) {
      const importedDefs = allDefs.filter((d) => importedFiles.has(d.filePath));
      if (importedDefs.length > 0) return { candidates: importedDefs, tier: "import-scoped" };
    }

    // Tier 2b: package-scoped
    const importedPackages = packageMap.get(fromFile);
    if (importedPackages) {
      const packageDefs = allDefs.filter((d) =>
        [...importedPackages].some((suffix) => isFileInPackageDir(d.filePath, suffix))
      );
      if (packageDefs.length > 0) return { candidates: packageDefs, tier: "import-scoped" };
    }

    // Tier 3: global fallback
    return { candidates: allDefs, tier: "global" };
  }

  function resolve(name: string, fromFile: string): TieredCandidates | null {
    if (cache !== null && cacheFile === fromFile) {
      if (cache.has(name)) {
        cacheHits++;
        return cache.get(name)!;
      }
      cacheMisses++;
    }

    const result = resolveUncached(name, fromFile);

    if (cache !== null && cacheFile === fromFile) {
      cache.set(name, result);
    }

    return result;
  }

  function enableCache(filePath: string): void {
    cacheFile = filePath;
    if (cache === null) cache = new Map();
    else cache.clear(); // reuse Map instance — reduces GC pressure
  }

  function clearCache(): void {
    cacheFile = null;
    cache?.clear(); // entries released; Map instance retained for reuse
  }

  function getStats(): ResolutionStats {
    const { fileCount, globalSymbolCount } = symbols.getStats();
    return { fileCount, globalSymbolCount, cacheHits, cacheMisses };
  }

  function clear(): void {
    symbols.clear();
    importMap.clear();
    packageMap.clear();
    namedImportMap.clear();
    cacheFile = null;
    cache?.clear();
    cacheHits = 0;
    cacheMisses = 0;
  }

  return {
    resolve,
    symbols,
    importMap,
    packageMap,
    namedImportMap,
    enableCache,
    clearCache,
    getStats,
    clear,
  };
}
