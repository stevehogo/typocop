/**
 * Named import binding helpers for Tier 2a-named resolution.
 *
 * Handles aliased re-export chains: A imports { User } from B,
 * B re-exports { User } from C — walkBindingChain resolves A→B→C.
 */
import type { SymbolDefinition, SymbolTable } from "./symbol-table.js";

export type NamedImportMap = Map<string, Map<string, NamedImportBinding>>;

export interface NamedImportBinding {
  readonly sourcePath: string;    // absolute path of the exporting file
  readonly exportedName: string;  // name as exported by sourcePath
}

/**
 * Follow a named-import re-export chain through namedImportMap.
 *
 * @param allDefs  Complete unfiltered lookupFuzzy(name) result — must NOT be pre-filtered.
 * @returns        Matching definitions, or null if chain breaks / depth exceeded / circular.
 */
export function walkBindingChain(
  name: string,
  currentFilePath: string,
  symbolTable: SymbolTable,
  namedImportMap: NamedImportMap,
  allDefs: SymbolDefinition[],
): SymbolDefinition[] | null {
  let lookupFile = currentFilePath;
  let lookupName = name;
  const visited = new Set<string>();

  for (let depth = 0; depth < 5; depth++) {
    const bindings = namedImportMap.get(lookupFile);
    if (!bindings) return null;

    const binding = bindings.get(lookupName);
    if (!binding) return null;

    const key = `${binding.sourcePath}:${binding.exportedName}`;
    if (visited.has(key)) return null; // circular reference
    visited.add(key);

    const targetName = binding.exportedName;

    // Use pre-fetched allDefs at depth=0 for non-aliased names (avoids extra lookup)
    const candidates =
      targetName !== lookupName || depth > 0
        ? symbolTable.lookupFuzzy(targetName).filter((d) => d.filePath === binding.sourcePath)
        : allDefs.filter((d) => d.filePath === binding.sourcePath);

    if (candidates.length > 0) return candidates;

    // Definition not in source file — follow re-export chain
    lookupFile = binding.sourcePath;
    lookupName = targetName;
  }

  return null;
}

/**
 * Check whether a file path falls within a package directory suffix.
 * Used by Tier 2b package-scoped resolution.
 */
export function isFileInPackageDir(filePath: string, dirSuffix: string): boolean {
  return filePath.includes(`/${dirSuffix}/`) || filePath.endsWith(`/${dirSuffix}`);
}
