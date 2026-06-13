/**
 * Symbol Table — two-index design for O(1) lookups.
 *
 * Two indexes (same SymbolDefinition object reference — zero extra memory):
 * - fileIndex: Map<filePath, Map<name, SymbolDefinition>> — O(1) exact lookup per file
 * - globalIndex: Map<name, SymbolDefinition[]> — global lookup across all files
 */
import type { Symbol } from "../../../core/domain.js";

export interface SymbolDefinition {
  /** References Symbol.id from src/types/index.ts */
  readonly nodeId: string;
  readonly filePath: string;
  /** SymbolKind string — 'function', 'class', 'method', etc. */
  readonly type: string;
  readonly parameterCount?: number;
  /** Raw return type text extracted from AST (e.g. 'User', 'Promise<User>') */
  readonly returnType?: string;
  /** Links Method/Constructor to owning Class/Struct nodeId */
  readonly ownerId?: string;
}

export interface SymbolTable {
  add(
    filePath: string,
    name: string,
    nodeId: string,
    type: string,
    metadata?: { parameterCount?: number; returnType?: string; ownerId?: string }
  ): void;

  /** O(1) exact lookup — returns nodeId only. Confidence 0.95. */
  lookupExact(filePath: string, name: string): string | undefined;

  /** O(1) exact lookup — returns full definition. Confidence 0.95. */
  lookupExactFull(filePath: string, name: string): SymbolDefinition | undefined;

  /** Global lookup — returns all definitions with this name. Confidence 0.50. */
  lookupFuzzy(name: string): SymbolDefinition[];

  getStats(): { fileCount: number; globalSymbolCount: number };
  clear(): void;
}

export function createSymbolTable(): SymbolTable {
  const fileIndex = new Map<string, Map<string, SymbolDefinition>>();
  const globalIndex = new Map<string, SymbolDefinition[]>();

  const add = (
    filePath: string,
    name: string,
    nodeId: string,
    type: string,
    metadata?: { parameterCount?: number; returnType?: string; ownerId?: string }
  ): void => {
    const def: SymbolDefinition = { nodeId, filePath, type, ...metadata };

    if (!fileIndex.has(filePath)) fileIndex.set(filePath, new Map());
    fileIndex.get(filePath)!.set(name, def);

    const existing = globalIndex.get(name);
    if (existing) existing.push(def);
    else globalIndex.set(name, [def]);
  };

  const lookupExact = (filePath: string, name: string): string | undefined =>
    fileIndex.get(filePath)?.get(name)?.nodeId;

  const lookupExactFull = (filePath: string, name: string): SymbolDefinition | undefined =>
    fileIndex.get(filePath)?.get(name);

  const lookupFuzzy = (name: string): SymbolDefinition[] =>
    globalIndex.get(name) ?? [];

  const getStats = (): { fileCount: number; globalSymbolCount: number } => ({
    fileCount: fileIndex.size,
    globalSymbolCount: globalIndex.size,
  });

  const clear = (): void => {
    fileIndex.clear();
    globalIndex.clear();
  };

  return { add, lookupExact, lookupExactFull, lookupFuzzy, getStats, clear };
}

/**
 * Build a SymbolTable from an array of symbols.
 * Convenience wrapper used by Phase 3 resolution.
 */
export function buildSymbolTable(symbols: Symbol[]): SymbolTable {
  const table = createSymbolTable();
  for (const sym of symbols) {
    table.add(sym.location.filePath, sym.name, sym.id, sym.kind);
  }
  return table;
}
