/**
 * Symbol Table — two-index design for O(1) lookups.
 *
 * Ported from legacy-parser/parser/ingestion/symbol-table.ts.
 * Adjusted to reference our Symbol type from src/types/index.ts.
 *
 * Two indexes:
 * - fileIndex: Map<filePath, Map<name, Symbol>> — O(1) exact lookup per file
 * - globalIndex: Map<name, Symbol[]> — fuzzy/global lookup across all files
 */
import type { Symbol } from "../../types/index.js";

export interface SymbolTable {
  /** Register a symbol into both indexes. */
  add(symbol: Symbol): void;

  /** High confidence: look up a symbol by exact name within a specific file. */
  lookupExact(filePath: string, name: string): Symbol | undefined;

  /** Low confidence: look up all symbols with a given name across all files. */
  lookupFuzzy(name: string): Symbol[];

  /** Debugging: see how many symbols are tracked. */
  getStats(): { fileCount: number; globalSymbolCount: number };

  /** Clear all indexes. */
  clear(): void;
}

export function createSymbolTable(): SymbolTable {
  // File-specific index: filePath → (name → Symbol)
  const fileIndex = new Map<string, Map<string, Symbol>>();

  // Global reverse index: name → Symbol[]
  const globalIndex = new Map<string, Symbol[]>();

  const add = (symbol: Symbol): void => {
    const { filePath } = symbol.location;

    // Add to file index
    if (!fileIndex.has(filePath)) {
      fileIndex.set(filePath, new Map());
    }
    fileIndex.get(filePath)!.set(symbol.name, symbol);

    // Add to global index (same object reference — zero extra memory)
    const existing = globalIndex.get(symbol.name);
    if (existing) {
      existing.push(symbol);
    } else {
      globalIndex.set(symbol.name, [symbol]);
    }
  };

  const lookupExact = (filePath: string, name: string): Symbol | undefined =>
    fileIndex.get(filePath)?.get(name);

  const lookupFuzzy = (name: string): Symbol[] =>
    globalIndex.get(name) ?? [];

  const getStats = (): { fileCount: number; globalSymbolCount: number } => ({
    fileCount: fileIndex.size,
    globalSymbolCount: globalIndex.size,
  });

  const clear = (): void => {
    fileIndex.clear();
    globalIndex.clear();
  };

  return { add, lookupExact, lookupFuzzy, getStats, clear };
}

/**
 * Build a SymbolTable from an array of symbols.
 * Convenience wrapper used by Phase 3 resolution.
 */
export function buildSymbolTable(symbols: Symbol[]): SymbolTable {
  const table = createSymbolTable();
  for (const sym of symbols) {
    table.add(sym);
  }
  return table;
}
