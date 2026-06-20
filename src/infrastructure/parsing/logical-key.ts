/**
 * Stable, position-INDEPENDENT node identity — `logicalKey` (A1, KEYSTONE).
 *
 * `generateSymbolId(filePath, name, startLine, startColumn)` is position-INCLUSIVE:
 * a symbol that merely moves down a line gets a brand-new id, which dangles every
 * inbound cross-file edge and silently breaks any diff-based re-index.
 *
 * `generateLogicalKey` is the persisted identity. It is derived only from
 * properties that survive a symbol moving within its file:
 *
 *     sha1(filePath \0 qualifiedName \0 kind \0 ordinal)
 *
 * The per-file `ordinal` disambiguates genuine same-`(file, name, kind)`
 * collisions (e.g. two anonymous arrow functions assigned to the same const
 * name, or two overloads). It is assigned in ORIGINAL file order so the mapping
 * is deterministic regardless of parse/completion order — moving a symbol down N
 * lines keeps its ordinal (and therefore its key) stable, while a NEW colliding
 * symbol appended later gets the next ordinal.
 *
 * `generateSymbolId` stays as the intra-run dedup/lookup key (it must stay
 * position-inclusive so two distinct symbols on the same line never collide and
 * get merged by `deduplicateById`). Only the EMITTED/PERSISTED endpoints (node
 * id, edge source/target, cluster/process/vector symbol refs, synthetic
 * import/unresolved ids) map to `logicalKey`. See {@link persistedKey} in
 * `core/domain.ts`.
 *
 * This lives in the infrastructure layer alongside `symbol-id.ts` so the query
 * extraction path can import it without a layering violation.
 */
import * as crypto from "node:crypto";

const NUL = "\0";

/**
 * Deterministic, position-independent logical key for a symbol.
 *
 * @param filePath      - Repository-relative file path (the same value used for
 *                        the symbol's `location.filePath`).
 * @param qualifiedName - The symbol's qualified name. v1 uses the bare symbol
 *                        name (resolution is name-keyed); a future deeper-
 *                        resolution pass may pass an enclosing-scope-qualified
 *                        name without changing this contract.
 * @param kind          - The symbol kind (`function`, `class`, …). Two symbols
 *                        with the same name but different kinds (a class and a
 *                        same-named variable) get distinct keys.
 * @param ordinal       - Per-`(file, qualifiedName, kind)` disambiguator,
 *                        assigned in original file order. Defaults to 0.
 */
export function generateLogicalKey(
  filePath: string,
  qualifiedName: string,
  kind: string,
  ordinal: number = 0,
): string {
  return crypto
    .createHash("sha1")
    .update(`${filePath}${NUL}${qualifiedName}${NUL}${kind}${NUL}${ordinal}`)
    .digest("hex");
}

/**
 * Stateful, per-file ordinal allocator for `(qualifiedName, kind)` collisions.
 *
 * Construct one per file, then call {@link OrdinalAllocator.next} once per symbol
 * IN ORIGINAL FILE ORDER. The first occurrence of a `(name, kind)` pair gets
 * ordinal 0, the second gets 1, and so on — so a unique symbol always gets 0 and
 * is unaffected by where it sits in the file.
 */
export class OrdinalAllocator {
  private readonly counts = new Map<string, number>();

  next(qualifiedName: string, kind: string): number {
    const key = `${qualifiedName}${NUL}${kind}`;
    const n = this.counts.get(key) ?? 0;
    this.counts.set(key, n + 1);
    return n;
  }
}
