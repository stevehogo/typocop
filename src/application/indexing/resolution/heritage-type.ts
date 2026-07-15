/**
 * Wave 7 (§3.1, Task 1) — interface-vs-class heritage disambiguation.
 *
 * Ported (rule logic only) from the legacy parser's `resolveExtendsType`
 * (typocop's pre-refactor parser lineage). Decides whether a heritage parent is
 * a CLASS super (`inherits`) or an INTERFACE/protocol/trait contract
 * (`implements`), so an external interface parent like `IDisposable` — which has
 * no in-repo `interface` Symbol — stops being miscategorised as `inherits` (and
 * its concrete same-name method stops becoming a spurious `overrides` instead of
 * `methodImplements`).
 *
 * KEYSTONE RULE (gating order — the symbol table wins for everything):
 *   Tier 1 — symbol table is AUTHORITATIVE. If the parent NAME resolves to ≥1
 *            Symbol, inspect the FIRST candidate's `kind`: `interface` →
 *            `implements`; anything else → `inherits`.
 *   Tier 2 — UNRESOLVED / external parent → language-gated heuristic:
 *            · C# / Java: `/^I[A-Z]/` naming convention → `implements`,
 *              otherwise fall through to the default.
 *            · Swift: unconditionally `implements` (protocol conformance is far
 *              more common than class inheritance in Swift).
 *            · all other languages: `inherits` (the others-extends default).
 *
 * Pure + side-effect-free so it is auditable in isolation (unit-tested). It maps
 * the legacy parser's EXTENDS/IMPLEMENTS verdict onto typocop's existing
 * `inherits`/`implements` relTypes — NO new RelationType is introduced.
 */
import type { Language, Symbol } from "../../../core/domain.js";

/** C#/Java convention: interfaces start with `I` followed by an uppercase letter (`IDisposable`, `IFoo`). */
const INTERFACE_NAME_RE = /^I[A-Z]/;

export type HeritageRelType = "inherits" | "implements";

/**
 * Resolve the correct heritage relType (`inherits` vs `implements`) for a parent.
 *
 * @param parentName  the parent type's NAME (as captured by the heritage hint).
 * @param sourceFile  the child symbol's file path (used to bias candidate pick).
 * @param language    the child/heritage language (carried on the hint).
 * @param symbolMap   name → Symbol[] map (the same one the hint loop already has).
 * @returns `implements` when the parent is (or heuristically is) an interface,
 *          else `inherits`.
 */
export function resolveHeritageRelType(
  parentName: string,
  sourceFile: string,
  language: Language,
  symbolMap: ReadonlyMap<string, Symbol[]>,
): HeritageRelType {
  // ── Tier 1: symbol table is authoritative ────────────────────────────────
  // Mirror the legacy `ctx.resolve(...).candidates[0].type === 'Interface'`
  // check, but consider ONLY real TYPE-DEFINITION candidates (`class` /
  // `interface`) — the legacy resolution context held only definitions, whereas
  // typocop's `symbolMap` also indexes imports / variables / etc. by name. A
  // parent that resolves only to non-type symbols (an `import` alias, a local
  // `variable`) is treated as UNRESOLVED here so the language-gated heuristic
  // below can still fire (otherwise an external `IDisposable` represented by an
  // import symbol would be wrongly locked to `inherits`). Prefer a same-file
  // candidate (closer to the legacy resolver's tier ordering), else the first by
  // name.
  const candidates = (symbolMap.get(parentName) ?? []).filter(
    (s) => s.kind === "class" || s.kind === "interface",
  );
  if (candidates.length > 0) {
    const primary =
      candidates.find((s) => s.location.filePath === sourceFile) ?? candidates[0];
    return primary.kind === "interface" ? "implements" : "inherits";
  }

  // ── Tier 2: unresolved / external parent → language-gated heuristic ───────
  if (language === "csharp" || language === "java") {
    if (INTERFACE_NAME_RE.test(parentName)) return "implements";
    // else fall through to the others-extends default below.
  } else if (language === "swift") {
    // Protocol conformance is far more common than class inheritance in Swift.
    return "implements";
  }

  // All other languages (and C#/Java names that fail the `^I[A-Z]` test) default
  // to class inheritance.
  return "inherits";
}
