/**
 * Phase 3: Reference resolution.
 *
 * Resolves raw relationship hints (from Phase 2 AST extraction) into
 * typed Relationship objects. Also exposes granular helpers for testing.
 *
 * Requirements: 3.3, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
 */
import type {
  ExternalDependencyNode,
  Symbol,
  Relationship,
  RelationType,
} from "../../../core/domain.js";
import type { Language } from "../../../core/domain.js";
import type { RawRelationshipHint } from "../parsing/index.js";
import { buildSymbolTable, symbolMetadata } from "./symbol-table.js";
import { createResolutionContext } from "./resolution-context.js";
import { populateImportMaps } from "./import-resolution-pass.js";
import { loadLanguageConfigs, type LanguageConfigs } from "../language-config.js";
import {
  getOrCreateExtNode,
  isExternalPackage,
} from "./external-packages.js";
import { getScopeResolver } from "./scope-resolver.js";
import type { CallResolutionDeps } from "./scope-resolver.js";
// Side-effect import: registers the built-in per-language scope resolvers (E1).
import "./resolvers/index.js";
import { computeMRO, c3Linearize, gatherAncestors } from "./mro.js";
import { resolveReceiverType, typeNameToSymbol, type ChainBindingDeps } from "./chain-binding.js";

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

/**
 * Attempt to resolve an import path using language config aliases/namespaces.
 * Returns the resolved path segment, or null if no alias matched.
 */
function resolveAlias(importPath: string, configs: LanguageConfigs): string | null {
  // TypeScript path aliases: e.g. "@/" -> "src/"
  if (configs.tsconfig) {
    for (const [alias, target] of configs.tsconfig.aliases) {
      if (importPath.startsWith(alias)) {
        return target + importPath.slice(alias.length);
      }
    }
  }
  // PHP PSR-4 namespaces: e.g. "App\" -> "app/"
  if (configs.composer) {
    const normalized = importPath.replace(/\\/g, "\\");
    for (const [ns, dir] of configs.composer.psr4) {
      if (normalized.startsWith(ns)) {
        return dir + "/" + normalized.slice(ns.length).replace(/\\/g, "/");
      }
    }
  }
  // Go module path: strip module prefix to get relative path
  if (configs.goModule) {
    const prefix = configs.goModule.modulePath + "/";
    if (importPath.startsWith(prefix)) {
      return importPath.slice(prefix.length);
    }
  }
  // Swift SPM targets
  if (configs.swift) {
    const target = configs.swift.targets.get(importPath);
    if (target !== undefined) return target;
  }
  return null;
}

export function resolveHints(
  hints: RawRelationshipHint[],
  symbols: Symbol[],
  languageConfigs?: LanguageConfigs,
  allFiles?: readonly string[],
  /**
   * Wave 3 (Tier B): when `true`, consume the type-env's `hint.receiverType`
   * (receiverType-FIRST member-call resolution) and enable the ported
   * return-type unwrap in chain binding. Default `false` → byte-identical
   * pre-Wave-3 behaviour (the field is also never populated when the flag is off
   * in Phase 2, so this is doubly safe — the zero-code rollback lever).
   */
  typeEnvResolution = false,
  /**
   * Wave 4 (Task 5): when `true`, the call-target selector narrows candidates by
   * callable-kind + arity + receiver-type and emits an edge ONLY when exactly one
   * survives (refuse-on-ambiguity). Default `false` → byte-identical pre-Wave-4
   * behaviour (the legacy `candidates[0]` / global-fallback path runs and the
   * Wave-4 filters never execute). The zero-code rollback lever.
   */
  callRefuseAmbiguous = false,
): ResolveHintsResult {
  const symbolMap = buildSymbolMap(symbols);
  const extNodes = new Map<string, ExternalDependencyNode>();

  // ─── Prebuilt lookup indexes (built once, used by all hints) ───────────────
  // symbolById: id → Symbol (used to resolve ctx candidate nodeIds, which are ids)
  const symbolById = new Map<string, Symbol>();
  // symbolsByFile: filePath → Symbol[] (was `fileSymbols`).
  // Kept in original insertion order so caller selection (below) matches the
  // prior per-hint `.find()` exactly: the FIRST symbol — in original order —
  // whose [startLine,endLine] range contains the hint line.
  const symbolsByFile = new Map<string, Symbol[]>();
  for (const sym of symbols) {
    symbolById.set(sym.id, sym);
    const list = symbolsByFile.get(sym.location.filePath) ?? [];
    list.push(sym);
    symbolsByFile.set(sym.location.filePath, list);
  }

  // Build resolution context and populate symbol table. E1: thread the optional
  // `{ parameterCount, returnType, ownerId }` metadata each Symbol carries into
  // the SymbolDefinition (data only — the default `single` strategy never reads
  // it, so the emitted edge set is byte-identical to pre-E1).
  const ctx = createResolutionContext();
  for (const sym of symbols) {
    ctx.symbols.add(sym.location.filePath, sym.name, sym.id, sym.kind, symbolMetadata(sym));
  }

  // ─── Wave 1: Activate the import-resolution graph ──────────────────────────
  // Populate ctx.importMap / packageMap / namedImportMap from the import hints +
  // the repo file list, BEFORE the hint loop's per-file `ctx.resolve` calls fire.
  // This turns on the dead Tiers 2a / 2a-named / 2b. When `allFiles` is omitted
  // (legacy/test call sites) OR no language configs are loaded, the sub-pass is
  // skipped and the maps stay empty → byte-identical pre-wave Tier-1/3 behaviour
  // (the built-in rollback lever).
  if (allFiles && allFiles.length > 0 && languageConfigs) {
    const importHints = hints.filter((h) => h.kind === "import");
    populateImportMaps(ctx, importHints, allFiles, languageConfigs);
  }

  // ─── E1 MRO / chain support indexes (built once) ───────────────────────────
  // methodsByOwner: ownerId → method/function Symbols owned by that type. Feeds
  // both MRO-aware member-call resolution and chain binding.
  const methodsByOwner = new Map<string, Symbol[]>();
  for (const sym of symbols) {
    if ((sym.kind !== "method" && sym.kind !== "function") || sym.ownerId === undefined) continue;
    const bucket = methodsByOwner.get(sym.ownerId) ?? [];
    bucket.push(sym);
    methodsByOwner.set(sym.ownerId, bucket);
  }
  // mroLinear: classId → C3-linearised ancestor ids, derived from the heritage
  // HINTS (independent of edge resolution, so available before the hint loop).
  const mroLinear = buildMroLinearizationFromHints(hints, symbols, symbolById);

  // Shared selector deps (parity selector + per-language resolvers). Wave 4: the
  // refuse-on-ambiguity flag rides here so the selector can switch between the
  // byte-identical legacy path (off) and the filtered single-survivor path (on).
  const callDeps: CallResolutionDeps = { ctx, symbolById, symbolMap, refuseAmbiguous: callRefuseAmbiguous };

  // DEPENDS_ON external-dependency fan-out reporting (behavior unchanged; count only).
  let dependsOnEdgeCount = 0;
  let maxDependsOnFanOutPerImport = 0;

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

    // Per-file ordinal for synthetic import source ids (A1). The old id
    // `${file}:import:${line}` was position-DEPENDENT — adding a line above an
    // import dangled its edge. The line is dropped; collisions (the same module
    // imported twice in one file) are disambiguated by a deterministic ordinal
    // assigned in hint order.
    const importOrdinals = new Map<string, number>();

    for (const hint of fileHints) {
      switch (hint.kind) {
        case "import": {
          const importOrd = importOrdinals.get(hint.targetName) ?? 0;
          importOrdinals.set(hint.targetName, importOrd + 1);
          const sourceId = importOrd === 0
            ? `${hint.sourceFile}:import:${hint.targetName}`
            : `${hint.sourceFile}:import:${hint.targetName}:${importOrd}`;
          if (isExternalPackage(hint.targetName, hint.language)) {
            const extNode = getOrCreateExtNode(hint.targetName, hint.language, extNodes);
            // Fan-out: one dependsOn edge from EVERY symbol in the importing file
            // to the ext node, per external import. Behavior intentionally
            // unchanged here — we only measure the amplification (see report below).
            const importingSymbols = symbolsByFile.get(hint.sourceFile) ?? [];
            let fanOut = 0;
            for (const importingSymbol of importingSymbols) {
              const before = relationships.length;
              add({
                id: relId("dependsOn", importingSymbol.id, extNode.id),
                source: importingSymbol.id,
                target: extNode.id,
                relType: "dependsOn",
                metadata: {
                  ecosystem: extNode.ecosystem,
                  packageName: extNode.name,
                },
              });
              if (relationships.length > before) fanOut++;
            }
            dependsOnEdgeCount += fanOut;
            if (fanOut > maxDependsOnFanOutPerImport) {
              maxDependsOnFanOutPerImport = fanOut;
            }
            break;
          }
          const segments = hint.targetName.split("/");
          const lastName = segments[segments.length - 1];

          // Attempt alias/namespace resolution via language configs before symbolMap lookup
          let resolvedTargetName = hint.targetName;
          if (languageConfigs) {
            const aliasResolved = resolveAlias(hint.targetName, languageConfigs);
            if (aliasResolved !== null) resolvedTargetName = aliasResolved;
          }

          const resolvedSegments = resolvedTargetName.split("/");
          const resolvedLastName = resolvedSegments[resolvedSegments.length - 1];

          // Use resolution context for same-file tier, fall back to symbolMap.
          // ctxResult.candidates[0].nodeId is a SYMBOL ID, so it must be resolved
          // via symbolById — NOT symbolMap (which is keyed by NAME). The old code
          // did `symbolMap.get(nodeId)` which (almost) always missed, leaving the
          // ctx same-file precise tier dead and falling through to the name
          // fallback. Resolving by id makes the precise tier actually win.
          const nameFallback = (): Symbol | undefined =>
            (symbolMap.get(resolvedLastName) ?? symbolMap.get(resolvedTargetName))?.[0]
            ?? (symbolMap.get(lastName) ?? symbolMap.get(hint.targetName))?.[0];
          const ctxResult = ctx.resolve(resolvedLastName ?? resolvedTargetName, hint.sourceFile);
          const target = ctxResult
            ? symbolById.get(ctxResult.candidates[0].nodeId) ?? nameFallback()
            : nameFallback();
          if (target) {
            add({ id: relId("imports", sourceId, target.id), source: sourceId, target: target.id, relType: "imports", metadata: {} });
          } else {
            add({ id: relId("imports", sourceId, `unresolved:${hint.targetName}`), source: sourceId, target: `unresolved:${hint.targetName}`, relType: "imports", metadata: { unresolved: "true" } });
          }
          break;
        }
        case "call": {
          // Caller lookup: FIRST symbol (in original file order) whose range
          // contains the hint line — identical selection to the prior .find().
          const fileSym = symbolsByFile.get(hint.sourceFile);
          const caller = fileSym?.find((s) => s.location.startLine <= hint.startLine && s.location.endLine >= hint.startLine);
          if (!caller) break;

          const resolver = getScopeResolver(hint.language);

          // ── E1 step 4: MRO-aware member-call resolution (ADDITIVE) ──────────
          // Only attempts when the resolver opts into `mro` AND the call has a
          // known receiver whose type linearises to an ancestor that declares the
          // method. Produces a target ONLY when the global single-strategy would
          // have produced a DIFFERENT (or no) one — never overriding an existing
          // same-file precise hit. If it yields nothing, we fall through to the
          // byte-identical parity selector below.
          let target: Symbol | undefined;
          // Wave 3 (Tier B): the type-env may have resolved a bare receiver to a
          // type name even when the resolver doesn't propagate return types (e.g.
          // a `new User()` local), so attempt member-call resolution when EITHER
          // a receiverText OR a flag-supplied receiverType is present.
          const teReceiverType = typeEnvResolution ? hint.receiverType : undefined;
          if (resolver.strategy === "mro" && (hint.receiverText || teReceiverType)) {
            target = resolveMemberCallTarget(
              hint.targetName,
              hint.receiverText ?? "",
              caller,
              { symbolById, symbolMap, methodsByOwner, mroLinear },
              resolver.propagatesReturnTypes,
              teReceiverType,
              typeEnvResolution,
            );
          }

          // ── Parity selector (today's behaviour byte-identical when the Wave-4
          // refuse flag is off; filtered single-survivor path when on). Wave 4
          // threads the call's `argCount`/`callForm` and the (typeEnv-gated)
          // `receiverType` so the selector can narrow by kind/arity/owning-type.
          // `teReceiverType` is already gated on `typeEnvResolution`, so when that
          // flag is off the receiver-type branch stays dark. ──────────────────
          if (!target) {
            target = resolver.selectCallTarget(
              {
                calleeName: hint.targetName,
                receiverText: hint.receiverText,
                caller,
                sourceFile: hint.sourceFile,
                argCount: hint.argCount,
                callForm: hint.callForm,
                receiverType: teReceiverType,
              },
              callDeps,
            );
          }

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

  // ── E1 step 3: MRO-derived edges (ADDITIVE) ────────────────────────────────
  // Computed AFTER the hint loop so all `inherits`/`implements` edges exist.
  // `computeMRO` emits ONLY new `overrides`/`methodImplements` relTypes; it never
  // touches existing edge ids. `add` dedups, so re-emission is a no-op. When no
  // symbol carries method `ownerId` (e.g. synthetic fixtures), it emits nothing —
  // golden output stays byte-identical.
  const mro = computeMRO(symbols, relationships);
  for (const rel of mro.relationships) add(rel);

  return {
    relationships,
    extNodes,
    dependsOnStats: {
      edgeCount: dependsOnEdgeCount,
      maxFanOutPerImport: maxDependsOnFanOutPerImport,
    },
  };
}

export interface DependsOnStats {
  /** Total dependsOn (external-dependency) edges generated. */
  readonly edgeCount: number;
  /** Largest number of dependsOn edges created by a single external import. */
  readonly maxFanOutPerImport: number;
}

export interface ResolveHintsResult {
  readonly relationships: Relationship[];
  readonly extNodes: Map<string, ExternalDependencyNode>;
  /**
   * Reporting only — surfaces the external-dependency fan-out amplification.
   * Optional because the legacy `resolveReferences` path does not produce it.
   */
  readonly dependsOnStats?: DependsOnStats;
}

// ─── E1 MRO-aware member-call resolution (ADDITIVE helpers) ───────────────────

/**
 * Build a `classId → C3-linearised ancestor ids` map from the heritage HINTS,
 * resolving each heritage hint's child/parent NAMES to concrete symbol ids. Used
 * by member-call resolution to walk a receiver type's ancestor chain. Independent
 * of edge resolution, so it can be built before the hint loop.
 */
function buildMroLinearizationFromHints(
  hints: RawRelationshipHint[],
  symbols: Symbol[],
  symbolById: Map<string, Symbol>,
): Map<string, string[]> {
  const byName = buildSymbolMap(symbols);
  const parentMap = new Map<string, string[]>();
  for (const hint of hints) {
    if (hint.kind !== "inherits" && hint.kind !== "implements") continue;
    if (!hint.childSymbolId) continue;
    const childCandidates = byName.get(hint.childSymbolId) ?? [];
    const child = childCandidates.find((s) => s.location.filePath === hint.sourceFile) ?? childCandidates[0];
    if (!child) continue;
    const parent = (byName.get(hint.targetName) ?? []).find((s) => s.id !== child.id);
    if (!parent) continue;
    const list = parentMap.get(child.id) ?? [];
    list.push(parent.id);
    parentMap.set(child.id, list);
  }
  const cache = new Map<string, string[] | null>();
  const out = new Map<string, string[]>();
  for (const classId of parentMap.keys()) {
    const linear = c3Linearize(classId, parentMap, cache);
    out.set(classId, linear ?? gatherAncestors(classId, parentMap));
  }
  // Make sure every symbolById key exists if needed by chain binding (no-op map
  // entries omitted intentionally).
  void symbolById;
  return out;
}

/**
 * MRO-aware member-call target selection (E1 step 4). Resolves the receiver type
 * (optionally via chain binding when `propagatesReturnTypes`), then walks the
 * receiver type's linearised ancestor chain for the FIRST type that declares a
 * method named `calleeName`. Returns `undefined` (→ parity fallback) when the
 * receiver type or method can't be determined.
 */
function resolveMemberCallTarget(
  calleeName: string,
  receiverText: string,
  caller: Symbol,
  deps: {
    symbolById: Map<string, Symbol>;
    symbolMap: Map<string, Symbol[]>;
    methodsByOwner: Map<string, Symbol[]>;
    mroLinear: Map<string, string[]>;
  },
  propagatesReturnTypes: boolean,
  /** Wave 3 (Tier B): the type-env's resolved receiver type NAME for a bare local. */
  receiverTypeName?: string,
  /** Wave 3 (Tier B): enable the ported return-type unwrap in chain binding. */
  useReturnTypeUnwrap = false,
): Symbol | undefined {
  const chainDeps: ChainBindingDeps = {
    symbolById: deps.symbolById,
    symbolMap: deps.symbolMap,
    methodsByOwner: deps.methodsByOwner,
  };

  // Search a resolved receiver TYPE symbol's own methods, then its linearised
  // ancestors, for the method. PRECISION GUARDRAIL: returns `undefined` (→ caller
  // tries the next tier / parity) rather than emitting a guessed edge.
  const searchType = (receiverType: Symbol): Symbol | undefined => {
    const ownMethod = (deps.methodsByOwner.get(receiverType.id) ?? []).find((m) => m.name === calleeName);
    if (ownMethod && ownMethod.id !== caller.id) return ownMethod;
    const linear = deps.mroLinear.get(receiverType.id) ?? [];
    for (const ancestorId of linear) {
      const m = (deps.methodsByOwner.get(ancestorId) ?? []).find((mm) => mm.name === calleeName);
      if (m && m.id !== caller.id) return m;
    }
    return undefined;
  };

  // ── Wave 3 (Tier B): receiverType-FIRST. When the per-file type-env resolved
  // the bare receiver to a type NAME, resolve THAT to a class symbol and search
  // it directly — this is the branch that turns `u.save()`→`User.save`. Only
  // fires when the type name resolves to a real class symbol; otherwise we fall
  // through to the existing receiver-text path (and then to parity), never
  // emitting an edge from a type name with no class. ─────────────────────────
  if (receiverTypeName) {
    const typeSym = typeNameToSymbol(receiverTypeName, chainDeps);
    if (typeSym) {
      const hit = searchType(typeSym);
      if (hit) return hit;
    }
  }

  // Resolve the receiver type from its raw text. `this`/`self` always work;
  // chained receivers only when the resolver propagates return types.
  const text = receiverText.trim();
  const isSelf = text === "this" || text === "self";
  if (!isSelf && !propagatesReturnTypes) return undefined;

  const receiverType = resolveReceiverType(receiverText, caller, chainDeps, useReturnTypeUnwrap);
  if (!receiverType) return undefined;

  return searchType(receiverType);
}

// ─── Phase 3 entry point ─────────────────────────────────────────────────────

/**
 * Phase 3 — Resolve all cross-symbol references.
 *
 * Accepts optional hints from Phase 2 AST extraction for richer call/import
 * resolution. Falls back to signature-based resolution when hints are absent
 * (supports legacy test usage with symbols only).
 *
 * When `repoRoot` is provided and hints are non-empty, language configs are
 * loaded concurrently before hint resolution to enable alias/namespace lookup.
 *
 * Requirements: 3.3, 5.1–5.7, 6.1, 6.5
 */
export async function resolveReferences(
  symbols: Symbol[],
  hints?: RawRelationshipHint[],
  repoRoot?: string,
  allFiles?: readonly string[],
  /**
   * Wave 3 (Tier B): forwarded to {@link resolveHints} to enable receiverType-
   * first member-call resolution + the chain-binding return-type unwrap. Default
   * `false` → byte-identical pre-Wave-3 (the zero-code rollback lever).
   */
  typeEnvResolution = false,
  /**
   * Wave 4 (Task 5): forwarded to {@link resolveHints} to enable refuse-on-
   * ambiguity call-target selection (callable-kind + arity + receiver-type
   * filtering, single-survivor-or-nothing). Default `false` → byte-identical
   * pre-Wave-4 behaviour (the zero-code rollback lever).
   */
  callRefuseAmbiguous = false,
): Promise<ResolveHintsResult> {
  if (hints && hints.length > 0) {
    const languageConfigs = repoRoot
      ? await loadLanguageConfigs(repoRoot)
      : undefined;
    return resolveHints(hints, symbols, languageConfigs, allFiles, typeEnvResolution, callRefuseAmbiguous);
  }

  // Legacy path: derive relationships from symbol kinds and signatures
  const symbolMap = buildSymbolMap(symbols);
  const symbolTable = buildSymbolTable(symbols);
  return {
    relationships: [
      ...resolveImports(symbols, symbolMap, symbolTable),
      ...resolveCalls(symbols, symbolMap),
      ...resolveInheritance(symbols, symbolMap),
      ...resolveImplementations(symbols, symbolMap),
    ],
    extNodes: new Map(),
  };
}
