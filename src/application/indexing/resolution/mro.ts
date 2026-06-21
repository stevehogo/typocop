/**
 * MRO / C3 linearization (E1 step 3).
 *
 * C3 linearization (`mro-processor.ts` + `model/resolve.ts`) and
 * `parameterTypesMatch` into typocop's slimmer model:
 *   - input  : the resolved `Symbol[]` + the `inherits`/`implements` edges already
 *              produced by the heritage hints
 *   - output : ADDITIVE `overrides` / `methodImplements` edges
 *
 * INVARIANTS (R7):
 *   - NEVER mutates or removes existing `inherits`/`implements` edges or ids.
 *   - Emits only NEW relTypes (`overrides`, `methodImplements`) with fresh ids.
 *   - Emits nothing for inputs lacking method `ownerId` info (so the synthetic
 *     golden fixtures, which carry no methods, produce zero MRO edges).
 *
 * Edge semantics:
 *   - `overrides`        : a subclass method M overrides the FIRST same-name,
 *                          arity-compatible method reachable via the C3-linearised
 *                          ancestor chain (skipping the class's own methods).
 *   - `methodImplements` : a concrete class method satisfies an interface/trait
 *                          method of the same name + compatible arity.
 */
import type { Language, Relationship, Symbol } from "../../../core/domain.js";

// ─── C3 linearization (ported, pure) ──────────────────────────────────────────

/**
 * Gather all ancestor ids in BFS order (excluding the class itself). Head-pointer
 * BFS avoids O(n) `Array.shift()`.
 */
export function gatherAncestors(classId: string, parentMap: Map<string, string[]>): string[] {
  const visited = new Set<string>();
  const order: string[] = [];
  const queue: string[] = [...(parentMap.get(classId) ?? [])];
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++]!;
    if (visited.has(id)) continue;
    visited.add(id);
    order.push(id);
    const grandparents = parentMap.get(id);
    if (grandparents) {
      for (const gp of grandparents) if (!visited.has(gp)) queue.push(gp);
    }
  }
  return order;
}

/**
 * Iterative C3 linearization. Returns the ancestor ids in C3/MRO order (excluding
 * the class itself), or `null` on a cyclic / inconsistent hierarchy. Iterative
 * (explicit work stack) to survive very deep hierarchies without overflow.
 */
export function c3Linearize(
  classId: string,
  parentMap: Map<string, string[]>,
  cache: Map<string, string[] | null>,
  inProgress?: Set<string>,
): string[] | null {
  if (cache.has(classId)) return cache.get(classId)!;

  const visiting = inProgress ?? new Set<string>();
  const ENTER = 0;
  const MERGE = 1;
  const stack: Array<{ id: string; phase: number }> = [{ id: classId, phase: ENTER }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];

    if (frame.phase === ENTER) {
      if (cache.has(frame.id)) { stack.pop(); continue; }
      if (visiting.has(frame.id)) { cache.set(frame.id, null); stack.pop(); continue; }
      visiting.add(frame.id);

      const directParents = parentMap.get(frame.id);
      if (!directParents || directParents.length === 0) {
        visiting.delete(frame.id);
        cache.set(frame.id, []);
        stack.pop();
        continue;
      }

      frame.phase = MERGE;
      let allParentsCached = true;
      for (let i = directParents.length - 1; i >= 0; i--) {
        const pid = directParents[i];
        if (!cache.has(pid)) { stack.push({ id: pid, phase: ENTER }); allParentsCached = false; }
      }
      if (!allParentsCached) continue;
    }

    // MERGE phase
    stack.pop();
    const directParents = parentMap.get(frame.id)!;

    const parentLinearizations: string[][] = [];
    let failed = false;
    for (const pid of directParents) {
      const pLin = cache.get(pid);
      if (pLin === undefined || pLin === null) { failed = true; break; }
      parentLinearizations.push([pid, ...pLin]);
    }
    if (failed) { visiting.delete(frame.id); cache.set(frame.id, null); continue; }

    const sequences = [...parentLinearizations, [...directParents]];
    const heads = new Uint32Array(sequences.length);
    const result: string[] = [];

    const tailCount = new Map<string, number>();
    for (const seq of sequences) {
      for (let i = 1; i < seq.length; i++) {
        tailCount.set(seq[i], (tailCount.get(seq[i]) ?? 0) + 1);
      }
    }

    let remaining = sequences.reduce((n, s) => n + s.length, 0);
    let inconsistent = false;

    while (remaining > 0) {
      let head: string | null = null;
      for (let si = 0; si < sequences.length; si++) {
        if (heads[si] >= sequences[si].length) continue;
        const candidate = sequences[si][heads[si]];
        if ((tailCount.get(candidate) ?? 0) === 0) { head = candidate; break; }
      }
      if (head === null) { inconsistent = true; break; }
      result.push(head);
      for (let si = 0; si < sequences.length; si++) {
        if (heads[si] >= sequences[si].length) continue;
        if (sequences[si][heads[si]] === head) {
          heads[si]++;
          remaining--;
          if (heads[si] < sequences[si].length) {
            const promoted = sequences[si][heads[si]];
            const prev = tailCount.get(promoted)!;
            if (prev <= 1) tailCount.delete(promoted);
            else tailCount.set(promoted, prev - 1);
          }
        }
      }
    }

    visiting.delete(frame.id);
    cache.set(frame.id, inconsistent ? null : result);
  }

  return cache.get(classId) ?? null;
}

// ─── parameterTypesMatch (ported) ─────────────────────────────────────────────

/**
 * Decide whether two methods' parameter lists are compatible for override /
 * implements matching. Lenient when type/arity info is missing (so we still link
 * by name), confident only on exact type or arity equality.
 */
export function parameterTypesMatch(
  a: readonly string[],
  b: readonly string[],
  aParamCount?: number,
  bParamCount?: number,
): { match: boolean; confident: boolean } {
  if ((aParamCount === undefined) !== (bParamCount === undefined)) {
    return { match: true, confident: false };
  }
  if (a.length === 0 || b.length === 0) {
    if (aParamCount !== undefined && bParamCount !== undefined) {
      const eq = aParamCount === bParamCount;
      return { match: eq, confident: eq };
    }
    return { match: true, confident: false };
  }
  if (a.length !== b.length) return { match: false, confident: false };
  const exact = a.every((t, i) => t === b[i]);
  return { match: exact, confident: exact };
}

// ─── Graph-level MRO emission ─────────────────────────────────────────────────

function mroRelId(relType: "overrides" | "methodImplements", source: string, target: string): string {
  return `${relType}:${source}->${target}`;
}

/** A method symbol grouped under its owner. */
interface OwnedMethod {
  readonly symbol: Symbol;
  readonly name: string;
  readonly paramCount?: number;
  readonly isAbstract: boolean;
}

// ─── Wave 7 (§3.1, Task 3) ambiguity diagnostics shapes (ADDITIVE) ────────────

/** One defining ancestor of a collided method name. */
export interface MethodAmbiguityDef {
  readonly classId: string;
  readonly className: string;
  readonly methodId: string;
}

/**
 * A method-name collision recorded for explainability (Wave 7, Task 3). Pushed
 * for EVERY ≥2-definer collision — even when it IS resolved (`resolvedTo`
 * non-null). `resolvedTo` is the winning ancestor methodId, or `null` for a
 * truly-unresolved case (C#/Java 2+-interface, Rust qualified-syntax). `reason`
 * carries the per-language rule that decided it.
 */
export interface MethodAmbiguity {
  readonly methodName: string;
  readonly definedIn: MethodAmbiguityDef[];
  readonly resolvedTo: string | null;
  readonly reason: string;
}

/**
 * Per-class MRO explainability entry (Wave 7, Task 3). One entry per class that
 * has parents (even with zero ambiguities) so the trace/explainability tools can
 * show the full linearisation. `mro` is the linearised ancestor NAMES (not ids).
 */
export interface MROEntry {
  readonly classId: string;
  readonly className: string;
  readonly language: Language | undefined;
  readonly mro: string[];
  readonly ambiguities: MethodAmbiguity[];
}

export interface MROResult {
  /** ADDITIVE overrides + methodImplements edges (never inherits/implements). */
  readonly relationships: Relationship[];
  /** Count of classes successfully C3-linearised (diagnostics). */
  readonly linearizedClassCount: number;
  /** True if any hierarchy was cyclic/inconsistent (C3 returned null). */
  readonly inconsistentHierarchy: boolean;
  // ── Wave 7 (§3.1, Task 3) ADDITIVE diagnostics ────────────────────────────
  /**
   * One entry per class with parents: its linearised ancestor NAMES and the
   * method-name collisions recorded during resolution. Purely additive — does
   * NOT affect the emitted edge set. ALWAYS populated (independent of the
   * heritage flag); the per-language ambiguity `reason` text is refined when the
   * flag is on.
   */
  readonly entries: MROEntry[];
  /** Count of recorded ambiguities whose `resolvedTo === null` (convenience). */
  readonly ambiguityCount: number;
}

// ─── Wave 7 (§3.1, Task 2) per-language collision resolution (rule logic) ─────
//
// Ported (rule logic only) from the legacy parser's `mro-processor.ts`
// resolvers. typocop's iterative C3 (`c3Linearize`) and arity-aware
// `parameterTypesMatch` are NOT touched — these resolvers operate on the ALREADY
// linearised ancestor order to decide the single OVERRIDES winner + diagnostic
// reason. They run ONLY when the heritage-disambiguation flag is on; with the
// flag off the legacy single-loop below is the sole edge producer.

/** A method definition reachable from a class via its MRO. */
interface CollisionDef {
  readonly classId: string;
  readonly className: string;
  readonly methodId: string;
}

interface Resolution {
  readonly resolvedTo: string | null;
  readonly reason: string;
}

/**
 * Resolve by MRO order — the FIRST ancestor in linearised order that defines the
 * method wins. Serves C++ (leftmost base in declaration order) and Python (C3
 * first-in-order) and the single-inheritance default; only `reasonPrefix`
 * differs. Never returns `null`.
 */
function resolveByMroOrder(
  methodName: string,
  defs: readonly CollisionDef[],
  mroOrder: readonly string[],
  reasonPrefix: string,
): Resolution {
  for (const ancestorId of mroOrder) {
    const match = defs.find((d) => d.classId === ancestorId);
    if (match) {
      return {
        resolvedTo: match.methodId,
        reason: `${reasonPrefix}: ${match.className}::${methodName}`,
      };
    }
  }
  return { resolvedTo: defs[0].methodId, reason: `${reasonPrefix} fallback: first definition` };
}

/**
 * C#/Java/Kotlin: a class method (EXTENDS / unknown edge) beats an interface
 * default; 2+ interface methods with the same name are ambiguous (null); exactly
 * one interface default wins. `interfaceAncestors` is the set of ancestor ids
 * reached via an `implements` edge (or whose symbol kind is `interface`).
 */
function resolveCsharpJava(
  methodName: string,
  defs: readonly CollisionDef[],
  interfaceAncestors: ReadonlySet<string>,
): Resolution {
  const classDefs: CollisionDef[] = [];
  const interfaceDefs: CollisionDef[] = [];
  for (const def of defs) {
    if (interfaceAncestors.has(def.classId)) interfaceDefs.push(def);
    else classDefs.push(def); // EXTENDS or unknown → treated as class
  }

  if (classDefs.length > 0) {
    return {
      resolvedTo: classDefs[0].methodId,
      reason: `class method wins: ${classDefs[0].className}::${methodName}`,
    };
  }
  if (interfaceDefs.length > 1) {
    return {
      resolvedTo: null,
      reason: `ambiguous: ${methodName} defined in multiple interfaces: ${interfaceDefs
        .map((d) => d.className)
        .join(", ")}`,
    };
  }
  if (interfaceDefs.length === 1) {
    return {
      resolvedTo: interfaceDefs[0].methodId,
      reason: `single interface default: ${interfaceDefs[0].className}::${methodName}`,
    };
  }
  return { resolvedTo: null, reason: "no resolution found" };
}

/**
 * Per-language collision resolution (rule logic ported). Decides the single
 * OVERRIDES winner + diagnostic reason for a method-name collision. Operates on
 * the already-linearised ancestor order; never touches the C3 or arity matcher.
 */
function resolveCollision(
  methodName: string,
  defs: readonly CollisionDef[],
  mroOrder: readonly string[],
  interfaceAncestors: ReadonlySet<string>,
  language: Language | undefined,
): Resolution {
  switch (language) {
    case "cpp":
      return resolveByMroOrder(methodName, defs, mroOrder, "C++ leftmost base");
    case "csharp":
    case "java":
      // (Kotlin in the legacy parser; typocop's `Language` union has no `kotlin`.)
      return resolveCsharpJava(methodName, defs, interfaceAncestors);
    case "python":
      return resolveByMroOrder(methodName, defs, mroOrder, "Python C3 MRO");
    case "rust":
      // Rust trait-method collisions are never auto-resolved.
      return {
        resolvedTo: null,
        reason: `Rust requires qualified syntax: <Type as Trait>::${methodName}()`,
      };
    default:
      return resolveByMroOrder(methodName, defs, mroOrder, "first definition");
  }
}

/**
 * Compute MRO-derived edges over the resolved symbols + heritage relationships.
 *
 * `heritage` is the subset of relationships that are `inherits` or `implements`
 * (caller may pass the full set; non-heritage rels are ignored). Interface/trait
 * parents (their methods are CONTRACTS) cause a concrete same-name method to
 * `methodImplements` them rather than `overrides`.
 *
 * Wave 7 (§3.1) additive parameters:
 *  - `languageOf`: optional accessor `classId → Language | undefined` (typocop's
 *    `Symbol` carries no `.language`, so the call site supplies it from the
 *    per-class heritage language). Used for the per-language tie-break rules +
 *    the `MROEntry.language` diagnostic. Omitted ⇒ `undefined` per class.
 *  - `heritageDisambiguation`: when `true`, the per-language collision resolvers
 *    decide the single OVERRIDES winner (and suppress it for Rust /
 *    multi-interface ambiguity) and the diagnostic `reason` is the per-language
 *    rule. When `false` (DEFAULT), the legacy single-loop is the SOLE edge
 *    producer (BYTE-IDENTICAL to pre-Wave-7) and ambiguity reasons use a neutral
 *    default. The Task-3 diagnostics (`entries`) are ALWAYS computed regardless.
 */
export function computeMRO(
  symbols: readonly Symbol[],
  heritage: readonly Relationship[],
  languageOf?: (classId: string) => Language | undefined,
  heritageDisambiguation = false,
): MROResult {
  const byId = new Map<string, Symbol>();
  for (const s of symbols) byId.set(s.id, s);

  // parentMap: classId → [parentId...] in declaration order (inherits before
  // implements, mirroring how heritage hints are emitted).
  const parentMap = new Map<string, string[]>();
  // Track which parents are interface/trait contracts vs concrete supers.
  const interfaceParent = new Map<string, Set<string>>(); // classId → set of interface parent ids
  const interfaceIds = new Set<string>();
  for (const s of symbols) if (s.kind === "interface") interfaceIds.add(s.id);

  for (const rel of heritage) {
    if (rel.relType !== "inherits" && rel.relType !== "implements") continue;
    if (!byId.has(rel.source) || !byId.has(rel.target)) continue;
    const list = parentMap.get(rel.source) ?? [];
    list.push(rel.target);
    parentMap.set(rel.source, list);
    if (rel.relType === "implements" || interfaceIds.has(rel.target)) {
      const set = interfaceParent.get(rel.source) ?? new Set<string>();
      set.add(rel.target);
      interfaceParent.set(rel.source, set);
    }
  }

  // methodMap: ownerId → OwnedMethod[]
  const methodMap = new Map<string, OwnedMethod[]>();
  for (const s of symbols) {
    if ((s.kind !== "method" && s.kind !== "function") || s.ownerId === undefined) continue;
    if (!byId.has(s.ownerId)) continue;
    const bucket = methodMap.get(s.ownerId) ?? [];
    bucket.push({
      symbol: s,
      name: s.name,
      paramCount: s.parameterCount,
      isAbstract: s.modifiers.includes("abstract"),
    });
    methodMap.set(s.ownerId, bucket);
  }

  const relationships: Relationship[] = [];
  const seen = new Set<string>();
  const add = (rel: Relationship): void => {
    if (!seen.has(rel.id)) { seen.add(rel.id); relationships.push(rel); }
  };

  const cache = new Map<string, string[] | null>();
  let linearizedClassCount = 0;
  let inconsistentHierarchy = false;
  const entries: MROEntry[] = [];
  let ambiguityCount = 0;

  // Only classes that own methods AND have parents can produce MRO edges.
  for (const [classId, ownMethods] of methodMap) {
    const parents = parentMap.get(classId);
    if (!parents || parents.length === 0) continue;

    const linear = c3Linearize(classId, parentMap, cache);
    if (linear === null) { inconsistentHierarchy = true; continue; }
    linearizedClassCount++;

    const classInterfaces = interfaceParent.get(classId) ?? new Set<string>();
    const language = languageOf?.(classId);

    // ── Task 2: per-language OVERRIDES winners (flag-gated) ──────────────────
    // Group same-name ancestor methods into collisions (2+ defining ancestors),
    // then resolve each per language. The result decides which concrete
    // `overrides` edge the emission loop below is allowed to emit (and suppresses
    // it for Rust / multi-interface ambiguity). `methodImplements` emission is
    // NEVER suppressed — interface contracts are always recorded. When the flag
    // is off this map is empty and the legacy loop emits unchanged.
    const overridesWinner = new Map<string, string | null>(); // methodName → winning methodId | null
    const ambiguities: MethodAmbiguity[] = [];

    if (heritageDisambiguation) {
      // Collect, per method NAME, every ANCESTOR (interface + concrete) that
      // defines it — in linearised (MRO) order, so the resolvers see the right
      // ordering. typocop emits edges from the CLASS's OWN methods, so a
      // collision is meaningful exactly when an own method matches 2+ ancestors
      // (e.g. one own `run` satisfying two interface contracts — the Java
      // default-method diamond — or overriding the first of several concrete
      // bases). We therefore only resolve names the own class actually defines.
      const defsByName = new Map<string, CollisionDef[]>();
      for (const ancestorId of linear) {
        const ancestorMethods = methodMap.get(ancestorId);
        if (!ancestorMethods) continue;
        const ancestorSym = byId.get(ancestorId);
        const ancestorName = ancestorSym?.name ?? ancestorId;
        for (const m of ancestorMethods) {
          const bucket = defsByName.get(m.name) ?? [];
          if (!bucket.some((d) => d.methodId === m.symbol.id)) {
            bucket.push({ classId: ancestorId, className: ancestorName, methodId: m.symbol.id });
          }
          defsByName.set(m.name, bucket);
        }
      }
      const ownNames = new Set(ownMethods.map((o) => o.name));
      const interfaceAncestors = new Set<string>();
      for (const ancestorId of linear) {
        if (classInterfaces.has(ancestorId) || interfaceIds.has(ancestorId)) {
          interfaceAncestors.add(ancestorId);
        }
      }
      for (const [methodName, defs] of defsByName) {
        if (defs.length < 2) continue;
        // Only the names the own class defines produce edges / are resolution
        // points in typocop's model (the own method overrides/implements the
        // collided ancestors). A purely-inherited conflict the class never
        // redefines emits no edge, so it is not recorded.
        if (!ownNames.has(methodName)) continue;
        const resolution = resolveCollision(methodName, defs, linear, interfaceAncestors, language);
        ambiguities.push({
          methodName,
          definedIn: defs.map((d) => ({ ...d })),
          resolvedTo: resolution.resolvedTo,
          reason: resolution.reason,
        });
        if (resolution.resolvedTo === null) ambiguityCount++;
        overridesWinner.set(methodName, resolution.resolvedTo);
      }
    }

    for (const own of ownMethods) {
      if (own.isAbstract) continue; // abstract methods don't override/implement
      // Walk the linearised ancestor chain; the FIRST same-name, arity-compatible
      // ancestor method wins. Interface ancestors → methodImplements; concrete
      // (class/struct) ancestors → overrides.
      for (const ancestorId of linear) {
        const ancestorMethods = methodMap.get(ancestorId);
        if (!ancestorMethods) continue;
        const matchInAncestor = ancestorMethods.find((m) => {
          if (m.name !== own.name) return false;
          return parameterTypesMatch([], [], own.paramCount, m.paramCount).match;
        });
        if (!matchInAncestor) continue;
        const isInterface = classInterfaces.has(ancestorId) || interfaceIds.has(ancestorId);
        if (isInterface) {
          add({
            id: mroRelId("methodImplements", own.symbol.id, matchInAncestor.symbol.id),
            source: own.symbol.id,
            target: matchInAncestor.symbol.id,
            relType: "methodImplements",
            metadata: {},
          });
          // Interface contracts can be satisfied by the same method across
          // multiple interfaces (Java default-method ambiguity), so DON'T break
          // — keep scanning for further interface contracts.
          continue;
        }
        // Concrete ancestor → `overrides` (single dispatch). The first concrete
        // match in the linearised walk is, by construction, the per-language
        // winner for C++ leftmost-base / Python C3 / C#-Java class-beats-interface
        // / default first-definition (defs are walked in MRO order; interface
        // ancestors are handled by the methodImplements branch above). So the ONLY
        // flag-ON change is SUPPRESSION: when the per-language resolver recorded a
        // collision for this name whose `resolvedTo` is null (Rust qualified-syntax
        // / 2+-interface ambiguity), emit no `overrides` edge. When the flag is off
        // (or the name had no recorded ≥2-definer collision), emit to the first
        // concrete match exactly as the legacy loop did.
        if (
          heritageDisambiguation &&
          overridesWinner.has(own.name) &&
          overridesWinner.get(own.name) === null
        ) {
          break; // ambiguous / unresolved → no overrides edge
        }
        add({
          id: mroRelId("overrides", own.symbol.id, matchInAncestor.symbol.id),
          source: own.symbol.id,
          target: matchInAncestor.symbol.id,
          relType: "overrides",
          metadata: {},
        });
        break; // single dispatch — stop at the resolved concrete target
      }
    }

    const className = byId.get(classId)?.name ?? classId;
    const mroNames = linear
      .map((id) => byId.get(id)?.name)
      .filter((n): n is string => n !== undefined);
    entries.push({ classId, className, language, mro: mroNames, ambiguities });
  }

  return { relationships, linearizedClassCount, inconsistentHierarchy, entries, ambiguityCount };
}
