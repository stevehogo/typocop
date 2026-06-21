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
import type { Relationship, Symbol } from "../../../core/domain.js";

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

export interface MROResult {
  /** ADDITIVE overrides + methodImplements edges (never inherits/implements). */
  readonly relationships: Relationship[];
  /** Count of classes successfully C3-linearised (diagnostics). */
  readonly linearizedClassCount: number;
  /** True if any hierarchy was cyclic/inconsistent (C3 returned null). */
  readonly inconsistentHierarchy: boolean;
}

/**
 * Compute MRO-derived edges over the resolved symbols + heritage relationships.
 *
 * `heritage` is the subset of relationships that are `inherits` or `implements`
 * (caller may pass the full set; non-heritage rels are ignored). `interfaceIds`
 * names the symbol ids that are interfaces/traits (their methods are CONTRACTS,
 * so a concrete same-name method `methodImplements` them rather than `overrides`).
 */
export function computeMRO(
  symbols: readonly Symbol[],
  heritage: readonly Relationship[],
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

  // Only classes that own methods AND have parents can produce MRO edges.
  for (const [classId, ownMethods] of methodMap) {
    const parents = parentMap.get(classId);
    if (!parents || parents.length === 0) continue;

    const linear = c3Linearize(classId, parentMap, cache);
    if (linear === null) { inconsistentHierarchy = true; continue; }
    linearizedClassCount++;

    const classInterfaces = interfaceParent.get(classId) ?? new Set<string>();

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
        const relType = isInterface ? "methodImplements" : "overrides";
        add({
          id: mroRelId(relType, own.symbol.id, matchInAncestor.symbol.id),
          source: own.symbol.id,
          target: matchInAncestor.symbol.id,
          relType,
          metadata: {},
        });
        // Interface contracts can be satisfied by the same method across multiple
        // interfaces (Java default-method ambiguity), so DON'T break on an
        // interface match — keep scanning for further interface contracts. Break
        // only once a concrete `overrides` target is found (single dispatch).
        if (!isInterface) break;
      }
    }
  }

  return { relationships, linearizedClassCount, inconsistentHierarchy };
}
