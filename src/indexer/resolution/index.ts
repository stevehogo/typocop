/**
 * Phase 3: Reference resolution.
 *
 * Resolves raw relationship hints (from Phase 2 AST extraction) into
 * typed Relationship objects. Also exposes granular helpers for testing.
 *
 * Requirements: 3.3, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
 */
import type { Symbol, Relationship, RelationType } from "../../types/index.js";
import type { RawRelationshipHint } from "../parsing/index.js";
import { buildSymbolTable } from "./symbol-table.js";
import { createResolutionContext } from "./resolution-context.js";

// ─── Symbol map ───────────────────────────────────────────────────────────────

export function buildSymbolMap(symbols: Symbol[]): Map<string, Symbol[]> {
  const map = new Map<string, Symbol[]>();
  for (const sym of symbols) {
    const existing = map.get(sym.name);
    if (existing) existing.push(sym);
    else map.set(sym.name, [sym]);
  }
  return map;
}

// ─── ID generation ────────────────────────────────────────────────────────────

function relId(relType: RelationType, source: string, target: string): string {
  return `${relType}:${source}->${target}`;
}

// ─── Granular helpers (used by tests and internally) ─────────────────────────

export function findImports(symbols: Symbol[]): Symbol[] {
  return symbols.filter((s) => s.kind === "import");
}

export function findCalls(symbols: Symbol[]): Symbol[] {
  return symbols.filter((s) => s.kind === "function" || s.kind === "method");
}

export function findClasses(symbols: Symbol[]): Symbol[] {
  return symbols.filter((s) => s.kind === "class");
}

export function findInterfaces(symbols: Symbol[]): Symbol[] {
  return symbols.filter((s) => s.kind === "interface");
}

/**
 * Resolve a single import symbol to its target.
 * Tier 1: same-file exact lookup. Tier 2: global name. Tier 3: last path segment.
 */
export function resolveImport(
  importSym: Symbol,
  symbolMap: Map<string, Symbol[]>,
  symbolTable?: ReturnType<typeof buildSymbolTable>,
): Symbol | undefined {
  if (symbolTable) {
    const sameFileId = symbolTable.lookupExact(importSym.location.filePath, importSym.name);
    if (sameFileId && sameFileId !== importSym.id) {
      const sameFile = (symbolMap.get(importSym.name) ?? []).find((s) => s.id === sameFileId);
      if (sameFile) return sameFile;
    }
  }

  const exact = symbolMap.get(importSym.name);
  if (exact && exact.length > 0 && exact[0].id !== importSym.id) return exact[0];

  const rawName = importSym.name.replace(/['"]/g, "");
  const segments = rawName.split("/");
  const lastName = segments[segments.length - 1];
  if (lastName && lastName !== importSym.name) {
    const bySegment = symbolMap.get(lastName);
    if (bySegment && bySegment.length > 0) return bySegment[0];
  }

  return undefined;
}

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
        id: relId("imports", importSym.id, target.id),
        source: importSym.id,
        target: target.id,
        relType: "imports",
        metadata: {},
      });
    } else {
      const unresolvedId = `unresolved:${importSym.name}`;
      relationships.push({
        id: relId("imports", importSym.id, unresolvedId),
        source: importSym.id,
        target: unresolvedId,
        relType: "imports",
        metadata: { unresolved: "true" },
      });
    }
  }

  return relationships;
}

export function resolveCall(
  callSym: Symbol,
  symbolMap: Map<string, Symbol[]>,
): Symbol | undefined {
  if (!callSym.signature) return undefined;
  const match = callSym.signature.match(/calls:\s*(\w+)/);
  if (!match) return undefined;
  const targets = symbolMap.get(match[1]);
  return targets?.find((t) => t.id !== callSym.id);
}

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
    const id = relId("calls", callSym.id, target.id);
    if (seen.has(id)) continue;
    seen.add(id);
    relationships.push({ id, source: callSym.id, target: target.id, relType: "calls", metadata: {} });
  }

  return relationships;
}

export function resolveInheritance(
  symbols: Symbol[],
  symbolMap: Map<string, Symbol[]>,
): Relationship[] {
  const relationships: Relationship[] = [];
  for (const cls of findClasses(symbols)) {
    if (!cls.signature) continue;
    const match = cls.signature.match(/\bextends\s+(\w+)/);
    if (!match) continue;
    const parent = (symbolMap.get(match[1]) ?? []).find((s) => s.id !== cls.id);
    if (!parent) continue;
    relationships.push({
      id: relId("inherits", cls.id, parent.id),
      source: cls.id, target: parent.id, relType: "inherits", metadata: {},
    });
  }
  return relationships;
}

export function resolveImplementations(
  symbols: Symbol[],
  symbolMap: Map<string, Symbol[]>,
): Relationship[] {
  const relationships: Relationship[] = [];
  for (const cls of findClasses(symbols)) {
    if (!cls.signature) continue;
    const match = cls.signature.match(/\bimplements\s+([\w,\s]+)/);
    if (!match) continue;
    for (const name of match[1].split(",").map((n) => n.trim()).filter(Boolean)) {
      const iface = (symbolMap.get(name) ?? []).find((s) => s.id !== cls.id);
      if (!iface) continue;
      relationships.push({
        id: relId("implements", cls.id, iface.id),
        source: cls.id, target: iface.id, relType: "implements", metadata: {},
      });
    }
  }
  return relationships;
}

// ─── Hint-based resolution (used by pipeline) ────────────────────────────────

export function resolveHints(
  hints: RawRelationshipHint[],
  symbols: Symbol[],
): Relationship[] {
  const symbolMap = buildSymbolMap(symbols);

  // Build resolution context and populate symbol table
  const ctx = createResolutionContext();
  for (const sym of symbols) {
    ctx.symbols.add(sym.location.filePath, sym.name, sym.id, sym.kind);
  }

  const fileSymbols = new Map<string, Symbol[]>();
  for (const sym of symbols) {
    const list = fileSymbols.get(sym.location.filePath) ?? [];
    list.push(sym);
    fileSymbols.set(sym.location.filePath, list);
  }

  const relationships: Relationship[] = [];
  const seen = new Set<string>();

  const add = (rel: Relationship): void => {
    if (!seen.has(rel.id)) { seen.add(rel.id); relationships.push(rel); }
  };

  // Group hints by source file so we can enable per-file cache
  const hintsByFile = new Map<string, RawRelationshipHint[]>();
  for (const hint of hints) {
    const list = hintsByFile.get(hint.sourceFile) ?? [];
    list.push(hint);
    hintsByFile.set(hint.sourceFile, list);
  }

  for (const [sourceFile, fileHints] of hintsByFile) {
    ctx.enableCache(sourceFile);

    for (const hint of fileHints) {
      switch (hint.kind) {
        case "import": {
          const sourceId = `${hint.sourceFile}:import:${hint.startLine}`;
          const segments = hint.targetName.split("/");
          const lastName = segments[segments.length - 1];
          // Use resolution context for same-file tier, fall back to symbolMap
          const ctxResult = ctx.resolve(lastName ?? hint.targetName, hint.sourceFile);
          const target = ctxResult
            ? symbolMap.get(ctxResult.candidates[0].nodeId) ?.[0]
              ?? (symbolMap.get(lastName) ?? symbolMap.get(hint.targetName))?.[0]
            : (symbolMap.get(lastName) ?? symbolMap.get(hint.targetName))?.[0];
          if (target) {
            add({ id: relId("imports", sourceId, target.id), source: sourceId, target: target.id, relType: "imports", metadata: {} });
          } else {
            add({ id: relId("imports", sourceId, `unresolved:${hint.targetName}`), source: sourceId, target: `unresolved:${hint.targetName}`, relType: "imports", metadata: { unresolved: "true" } });
          }
          break;
        }
        case "call": {
          const fileSym = fileSymbols.get(hint.sourceFile);
          const caller = fileSym?.find((s) => s.location.startLine <= hint.startLine && s.location.endLine >= hint.startLine);
          if (!caller) break;
          const ctxResult = ctx.resolve(hint.targetName, hint.sourceFile);
          const resolvedId = ctxResult?.candidates[0]?.nodeId;
          const sameFile = resolvedId ? (symbolMap.get(hint.targetName) ?? []).find((s) => s.id === resolvedId) : undefined;
          const target = (sameFile && sameFile.id !== caller.id) ? sameFile
            : (symbolMap.get(hint.targetName) ?? []).find((s) => s.id !== caller.id);
          if (target) add({ id: relId("calls", caller.id, target.id), source: caller.id, target: target.id, relType: "calls", metadata: {} });
          break;
        }
        case "inherits":
        case "implements": {
          if (!hint.childSymbolId) break;
          const childCandidates = symbolMap.get(hint.childSymbolId) ?? [];
          const child = childCandidates.find((s) => s.location.filePath === hint.sourceFile) ?? childCandidates[0];
          if (!child) break;
          const parent = (symbolMap.get(hint.targetName) ?? []).find((s) => s.id !== child.id);
          if (!parent) break;
          const relType: RelationType = hint.kind === "inherits" ? "inherits" : "implements";
          add({ id: relId(relType, child.id, parent.id), source: child.id, target: parent.id, relType, metadata: {} });
          break;
        }
      }
    }

    ctx.clearCache();
  }

  return relationships;
}

// ─── Phase 3 entry point ─────────────────────────────────────────────────────

/**
 * Phase 3 — Resolve all cross-symbol references.
 *
 * Accepts optional hints from Phase 2 AST extraction for richer call/import
 * resolution. Falls back to signature-based resolution when hints are absent
 * (supports legacy test usage with symbols only).
 *
 * Requirements: 3.3, 5.1–5.7
 */
export function resolveReferences(
  symbols: Symbol[],
  hints?: RawRelationshipHint[],
): Relationship[] {
  if (hints && hints.length > 0) {
    return resolveHints(hints, symbols);
  }

  // Legacy path: derive relationships from symbol kinds and signatures
  const symbolMap = buildSymbolMap(symbols);
  const symbolTable = buildSymbolTable(symbols);
  return [
    ...resolveImports(symbols, symbolMap, symbolTable),
    ...resolveCalls(symbols, symbolMap),
    ...resolveInheritance(symbols, symbolMap),
    ...resolveImplementations(symbols, symbolMap),
  ];
}
