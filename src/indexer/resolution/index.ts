/**
 * Phase 3: Reference resolution.
 *
 * Resolves imports, function calls, class inheritance, and interface
 * implementations across all extracted symbols, producing Relationship objects.
 *
 * Requirements: 3.3, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
 */
import type { Symbol, Relationship, RelationType } from "../../types/index.js";
import { buildSymbolTable } from "./symbol-table.js";

// ─── Symbol Map ───────────────────────────────────────────────────────────────

/**
 * Build a fast name → Symbol[] lookup map.
 * Multiple symbols may share a name (overloads, different files).
 *
 * Requirements: 5.5 — relationships must reference existing symbols.
 */
export function buildSymbolMap(symbols: Symbol[]): Map<string, Symbol[]> {
  const map = new Map<string, Symbol[]>();
  for (const sym of symbols) {
    const existing = map.get(sym.name);
    if (existing) {
      existing.push(sym);
    } else {
      map.set(sym.name, [sym]);
    }
  }
  return map;
}

// ─── Relationship ID generation ───────────────────────────────────────────────

function generateRelationshipId(
  relType: RelationType,
  source: string,
  target: string,
): string {
  return `${relType}:${source}->${target}`;
}

// ─── 7.1 Import resolution ────────────────────────────────────────────────────

/**
 * Extract all symbols that represent import statements (kind "import").
 *
 * Requirements: 5.1
 */
export function findImports(symbols: Symbol[]): Symbol[] {
  return symbols.filter((s) => s.kind === "import");
}

/**
 * Resolve a single import symbol to its target using a three-tier strategy:
 * 1. Same-file exact lookup via SymbolTable (highest confidence)
 * 2. Global exact name match
 * 3. Last path segment (e.g., "./utils/foo" → "foo")
 *
 * Returns the best-match Symbol, or undefined when unresolvable.
 *
 * Requirements: 5.1, 5.6
 */
export function resolveImport(
  importSym: Symbol,
  symbolMap: Map<string, Symbol[]>,
  symbolTable?: ReturnType<typeof buildSymbolTable>,
): Symbol | undefined {
  // Tier 1: same-file exact lookup (requires SymbolTable)
  if (symbolTable) {
    const sameFile = symbolTable.lookupExact(importSym.location.filePath, importSym.name);
    if (sameFile && sameFile.id !== importSym.id) return sameFile;
  }

  // Tier 2: global exact name match
  const exact = symbolMap.get(importSym.name);
  if (exact && exact.length > 0 && exact[0].id !== importSym.id) {
    return exact[0];
  }

  // Tier 3: last path segment (strip quotes)
  const rawName = importSym.name.replace(/['"]/g, "");
  const segments = rawName.split("/");
  const lastName = segments[segments.length - 1];
  if (lastName && lastName !== importSym.name) {
    const bySegment = symbolMap.get(lastName);
    if (bySegment && bySegment.length > 0) return bySegment[0];
  }

  return undefined;
}

/**
 * Resolve all import relationships for the given symbol set.
 *
 * - Resolved → Relationship with relType "imports", empty metadata
 * - Unresolved → Relationship with metadata { unresolved: "true" } (Req 5.6)
 *
 * Requirements: 5.1, 5.5, 5.6, 5.7
 */
export function resolveImports(
  symbols: Symbol[],
  symbolMap: Map<string, Symbol[]>,
  symbolTable?: ReturnType<typeof buildSymbolTable>,
): Relationship[] {
  const imports = findImports(symbols);
  const relationships: Relationship[] = [];

  for (const importSym of imports) {
    const target = resolveImport(importSym, symbolMap, symbolTable);

    if (target) {
      relationships.push({
        id: generateRelationshipId("imports", importSym.id, target.id),
        source: importSym.id,
        target: target.id,
        relType: "imports",
        metadata: {},
      });
    } else {
      const unresolvedTargetId = `unresolved:${importSym.name}`;
      relationships.push({
        id: generateRelationshipId("imports", importSym.id, unresolvedTargetId),
        source: importSym.id,
        target: unresolvedTargetId,
        relType: "imports",
        metadata: { unresolved: "true" },
      });
    }
  }

  return relationships;
}

// ─── 7.2 Call resolution ──────────────────────────────────────────────────────

/**
 * Extract function/method symbols as potential call sites.
 *
 * Requirements: 5.2
 */
export function findCalls(symbols: Symbol[]): Symbol[] {
  return symbols.filter((s) => s.kind === "function" || s.kind === "method");
}

/**
 * Resolve a single call symbol to its callee via signature annotation
 * ("calls: targetName").
 *
 * Requirements: 5.2
 */
export function resolveCall(
  callSym: Symbol,
  symbolMap: Map<string, Symbol[]>,
): Symbol | undefined {
  if (!callSym.signature) return undefined;

  const callsMatch = callSym.signature.match(/calls:\s*(\w+)/);
  if (!callsMatch) return undefined;

  const targetName = callsMatch[1];
  const targets = symbolMap.get(targetName);
  if (targets && targets.length > 0 && targets[0].id !== callSym.id) {
    return targets[0];
  }

  return undefined;
}

/**
 * Resolve all call relationships across the symbol set.
 * Unresolvable calls are silently skipped.
 *
 * Requirements: 5.2, 5.5
 */
export function resolveCalls(
  symbols: Symbol[],
  symbolMap: Map<string, Symbol[]>,
): Relationship[] {
  const callSymbols = findCalls(symbols);
  const relationships: Relationship[] = [];
  const seen = new Set<string>();

  for (const callSym of callSymbols) {
    const target = resolveCall(callSym, symbolMap);
    if (!target || target.id === callSym.id) continue;

    const relId = generateRelationshipId("calls", callSym.id, target.id);
    if (seen.has(relId)) continue;
    seen.add(relId);

    relationships.push({
      id: relId,
      source: callSym.id,
      target: target.id,
      relType: "calls",
      metadata: {},
    });
  }

  return relationships;
}

// ─── 7.3 Inheritance and interface resolution ─────────────────────────────────

/** Extract class symbols. Requirements: 5.3 */
export function findClasses(symbols: Symbol[]): Symbol[] {
  return symbols.filter((s) => s.kind === "class");
}

/** Extract interface symbols. Requirements: 5.4 */
export function findInterfaces(symbols: Symbol[]): Symbol[] {
  return symbols.filter((s) => s.kind === "interface");
}

/**
 * Resolve class inheritance via `extends <ParentName>` in signatures.
 *
 * Requirements: 5.3, 5.5
 */
export function resolveInheritance(
  symbols: Symbol[],
  symbolMap: Map<string, Symbol[]>,
): Relationship[] {
  const classes = findClasses(symbols);
  const relationships: Relationship[] = [];

  for (const cls of classes) {
    if (!cls.signature) continue;

    const extendsMatch = cls.signature.match(/\bextends\s+(\w+)/);
    if (!extendsMatch) continue;

    const parents = symbolMap.get(extendsMatch[1]);
    if (!parents || parents.length === 0) continue;

    const parent = parents[0];
    if (parent.id === cls.id) continue;

    relationships.push({
      id: generateRelationshipId("inherits", cls.id, parent.id),
      source: cls.id,
      target: parent.id,
      relType: "inherits",
      metadata: {},
    });
  }

  return relationships;
}

/**
 * Resolve interface implementations via `implements A, B` in signatures.
 *
 * Requirements: 5.4, 5.5
 */
export function resolveImplementations(
  symbols: Symbol[],
  symbolMap: Map<string, Symbol[]>,
): Relationship[] {
  const classes = findClasses(symbols);
  const relationships: Relationship[] = [];

  for (const cls of classes) {
    if (!cls.signature) continue;

    const implementsMatch = cls.signature.match(/\bimplements\s+([\w,\s]+)/);
    if (!implementsMatch) continue;

    const interfaceNames = implementsMatch[1]
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);

    for (const ifaceName of interfaceNames) {
      const targets = symbolMap.get(ifaceName);
      if (!targets || targets.length === 0) continue;

      const iface = targets[0];
      if (iface.id === cls.id) continue;

      relationships.push({
        id: generateRelationshipId("implements", cls.id, iface.id),
        source: cls.id,
        target: iface.id,
        relType: "implements",
        metadata: {},
      });
    }
  }

  return relationships;
}

// ─── Phase 3 pipeline entry point ────────────────────────────────────────────

/**
 * Phase 3 — Resolve all cross-symbol references and return Relationship[].
 *
 * Uses SymbolTable internally for same-file tier resolution on imports.
 * All returned relationships reference symbol IDs that exist in the input set,
 * or are flagged `unresolved: "true"` for unresolvable imports (Req 5.6).
 *
 * Requirements: 3.3, 5.1–5.7
 */
export function resolveReferences(symbols: Symbol[]): Relationship[] {
  const symbolMap = buildSymbolMap(symbols);
  const symbolTable = buildSymbolTable(symbols);

  return [
    ...resolveImports(symbols, symbolMap, symbolTable),
    ...resolveCalls(symbols, symbolMap),
    ...resolveInheritance(symbols, symbolMap),
    ...resolveImplementations(symbols, symbolMap),
  ];
}
