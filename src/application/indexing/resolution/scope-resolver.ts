/**
 * ScopeResolver registry (E1 step 2).
 *
 * A deliberately SLIM, ~5-field per-language strategy contract — the opposite of
 * ~50-field scope model. It captures only the knobs that change how a
 * *call target* is selected once the tiered {@link ResolutionContext} has produced
 * candidates:
 *
 *   - `strategy`            : `"single"` (parity default) or `"mro"`
 *   - `propagatesReturnTypes`: enables chain binding (`a.getB().getC()`)
 *   - `selectCallTarget`    : the actual candidate-selection function
 *
 * The `single` strategy reproduces TODAY's behaviour byte-for-byte: take the
 * first tiered candidate, refine to a same-file symbol when it differs from the
 * caller, else fall back to the global name match (first symbol that isn't the
 * caller). Every existing golden/PBT test passes under `single` unchanged.
 *
 * Per-language resolvers live in `resolvers/*` and differ only by toggling
 * `strategy`/`propagatesReturnTypes`; the selection mechanics are shared here so
 * there is exactly one place that can drift from parity.
 *
 * Wave 4 (call-resolution precision) ADDS a candidate-FILTERING path inside the
 * selector — callable-kind + arity + receiver-type narrowing, then refuse-on-
 * ambiguity (single-survivor-or-nothing). The entire filtered path is gated by
 * `CallResolutionDeps.refuseAmbiguous` (default `false`); when off, the selector
 * runs the byte-identical legacy `candidates[0]` / global-fallback logic and the
 * Wave-4 filter helpers never execute, so golden output is unchanged. The shared
 * {@link filterCallableCandidates} helper is exported so other selectors (and
 * tests) reuse the same kind/arity discipline.
 */
import type { Language, Symbol } from "../../../core/domain.js";
import type { ResolutionContext } from "./resolution-context.js";
import type { SymbolDefinition } from "./symbol-table.js";

/** How a member/free call's target is chosen from tiered candidates. */
export type ResolveStrategy = "single" | "mro";

/** Call-site form carried on a `call` hint (Wave 4). */
export type CallForm = "free" | "member" | "constructor";

/** Inputs a call-target selector receives — kept minimal and read-only. */
export interface CallResolutionInput {
  /** Bare callee name (e.g. `getUser`). */
  readonly calleeName: string;
  /** Raw receiver text for member calls (`recv` in `recv.getUser()`), if any. */
  readonly receiverText?: string;
  /** The resolved caller symbol at the call site. */
  readonly caller: Symbol;
  /** Source file the call appears in. */
  readonly sourceFile: string;
  /**
   * Wave 4: direct argument count at the call site (`undefined` when not cheaply
   * countable — arity narrowing is then SKIPPED). Read only on the
   * `refuseAmbiguous` filtered path.
   */
  readonly argCount?: number;
  /**
   * Wave 4: the call form (`free`/`member`/`constructor`). Drives the callable-
   * kind filter (constructor-form → `class`). Read only on the filtered path.
   */
  readonly callForm?: CallForm;
  /**
   * Wave 4: the receiver's resolved type NAME for a member call (supplied by the
   * Wave-3 type-env, gated on `typeEnvResolution`). Used to narrow the member-
   * call candidate pool by owning type. `undefined` ⇒ the receiver-type branch
   * is a dark no-op. Read only on the filtered path.
   */
  readonly receiverType?: string;
}

/** Lookups a selector may use — supplied by `resolveHints`, never imported. */
export interface CallResolutionDeps {
  readonly ctx: ResolutionContext;
  /** id → Symbol (tiered candidate ids are symbol ids). */
  readonly symbolById: ReadonlyMap<string, Symbol>;
  /** name → Symbol[] (global name fallback). */
  readonly symbolMap: ReadonlyMap<string, Symbol[]>;
  /**
   * Wave 4 (Task 5) refuse-on-ambiguity discipline. **Default `false`.** When
   * `false`, the selector runs the byte-identical legacy `candidates[0]` /
   * global-fallback path and the Wave-4 filters never execute (golden parity).
   * When `true`, the selector narrows candidates by callable-kind + arity +
   * receiver-type and emits a target ONLY when exactly one survives (otherwise
   * `undefined` → no edge). Derived from `PipelineConfig.callRefuseAmbiguous` at
   * the composition root.
   */
  readonly refuseAmbiguous?: boolean;
}

/** A per-language resolution strategy. Slim by design (≈5 fields). */
export interface ScopeResolver {
  readonly language: Language | "default";
  readonly strategy: ResolveStrategy;
  /** When true, chain-binding threads return types through `a.b().c()`. */
  readonly propagatesReturnTypes: boolean;
  /** Choose the call target, or `undefined` if none. */
  selectCallTarget(input: CallResolutionInput, deps: CallResolutionDeps): Symbol | undefined;
}

// ─── Wave 4: callable-kind + arity candidate filtering ─────────────────────────

/**
 * Callable `SymbolKind`s in typocop's lowercase vocabulary. The legacy parser's
 * capitalized `Function`/`Method`/`Constructor`/`Macro`/`Delegate` all map onto
 * these two: constructors are modelled as methods/functions, and typocop has no
 * `macro`/`delegate` kind (those invocables fold into `function`/`method`).
 */
const CALLABLE_SYMBOL_TYPES: ReadonlySet<string> = new Set(["function", "method"]);

/**
 * Constructor-form call TARGET kinds. The legacy parser's
 * `Constructor`/`Class`/`Struct`/`Record` all collapse onto typocop's single
 * `class` kind (no `struct`/`record` kind; a `Constructor` symbol is just a
 * method on its class, so the explicit-`Constructor`-first tier is empty in
 * typocop and is folded straight into the `class` tier here).
 */
const CONSTRUCTOR_TARGET_TYPES: ReadonlySet<string> = new Set(["class"]);

/**
 * Filter a candidate pool to callable symbols, then by arity. Ported from the
 * legacy parser's `filterCallableCandidates`, re-keyed to typocop's lowercase
 * `SymbolKind` vocabulary.
 *
 * Kind filter:
 *  - `callForm === "constructor"` ⇒ narrow to constructor-target kinds
 *    (`{ class }`), falling back to general callables (`{ function, method }`)
 *    when no class candidate exists.
 *  - otherwise ⇒ keep general callables.
 *
 * Arity filter (THREE load-bearing escape hatches, preserved verbatim):
 *  1. `argCount === undefined` ⇒ skip arity narrowing, return the kind-filtered
 *     set unchanged. (This is why `countCallArguments` returns `undefined`, never
 *     `0`, when it can't find the container.)
 *  2. if NO surviving candidate carries `parameterCount` (`hasParameterMetadata`)
 *     ⇒ return unfiltered (can't filter on absent data).
 *  3. per-candidate `parameterCount === undefined` ALWAYS passes — a candidate
 *     lacking arity metadata (e.g. a variadic / unsupported-language signature)
 *     is never rejected on arity grounds; only candidates whose known
 *     `parameterCount !== argCount` are dropped.
 */
export function filterCallableCandidates(
  candidates: readonly SymbolDefinition[],
  argCount?: number,
  callForm?: CallForm,
): SymbolDefinition[] {
  let kindFiltered: SymbolDefinition[];

  if (callForm === "constructor") {
    const types = candidates.filter((c) => CONSTRUCTOR_TARGET_TYPES.has(c.type));
    kindFiltered = types.length > 0 ? types : candidates.filter((c) => CALLABLE_SYMBOL_TYPES.has(c.type));
  } else {
    kindFiltered = candidates.filter((c) => CALLABLE_SYMBOL_TYPES.has(c.type));
  }

  if (kindFiltered.length === 0) return [];
  if (argCount === undefined) return kindFiltered; // escape hatch 1

  const hasParameterMetadata = kindFiltered.some((c) => c.parameterCount !== undefined);
  if (!hasParameterMetadata) return kindFiltered; // escape hatch 2

  return kindFiltered.filter(
    (c) => c.parameterCount === undefined || c.parameterCount === argCount, // escape hatch 3
  );
}

/**
 * The Wave-4 filtered selector (`refuseAmbiguous` ON). Tier-narrow via
 * `ctx.resolve` → callable-kind + arity filter → optional receiver-type narrowing
 * for member calls → refuse unless exactly one candidate survives. Maps the
 * surviving `SymbolDefinition.nodeId` back to a `Symbol` via `symbolById`. Ported
 * from the legacy parser's `resolveCallTarget` (re-keyed to typocop's vocabulary
 * and `Symbol`-id mapping).
 *
 * PRECISION: returns `undefined` (→ no `calls` edge) rather than guessing among
 * ambiguous siblings; never returns the caller itself.
 */
function selectFiltered(
  input: CallResolutionInput,
  deps: CallResolutionDeps,
): Symbol | undefined {
  const { calleeName, caller, sourceFile, argCount, callForm, receiverType } = input;
  const { ctx, symbolById } = deps;

  const tiered = ctx.resolve(calleeName, sourceFile);
  if (!tiered) return undefined;

  // Map a surviving definition to a non-caller Symbol (the caller self-edge guard
  // is preserved from the legacy `selectSingle`).
  const toSymbol = (def: SymbolDefinition | undefined): Symbol | undefined => {
    if (!def) return undefined;
    const sym = symbolById.get(def.nodeId);
    return sym && sym.id !== caller.id ? sym : undefined;
  };

  const filteredCandidates = filterCallableCandidates(tiered.candidates, argCount, callForm);

  // ── Task 4: receiver-type narrowing for member calls (dark when receiverType
  // is absent — the common case until Wave 3's type-env supplies it). Composes
  // with (does NOT duplicate) the `mro`-strategy `resolveMemberCallTarget`
  // receiverType-first branch in `resolution/index.ts`: that branch fires only
  // for `strategy: "mro"` and BYPASSES this selector on a hit, so this narrowing
  // owns the `single`-strategy member-call path where that branch is dead. ──────
  if (callForm === "member" && receiverType) {
    const typeResolved = ctx.resolve(receiverType, sourceFile);
    if (typeResolved && typeResolved.candidates.length > 0) {
      const typeNodeIds = new Set(typeResolved.candidates.map((d) => d.nodeId));
      const typeFiles = new Set(typeResolved.candidates.map((d) => d.filePath));

      // When the scope-tiered pool already collapsed to ≤1, RE-WIDEN via the
      // fuzzy global index and re-filter, so the receiver type has a pool to
      // narrow rather than blindly accepting the single tiered hit.
      const methodPool =
        filteredCandidates.length <= 1
          ? filterCallableCandidates(ctx.symbols.lookupFuzzy(calleeName), argCount, callForm)
          : filteredCandidates;

      // Step 1: narrow by the receiver type's FILE(s); a unique survivor resolves.
      const fileFiltered = methodPool.filter((c) => typeFiles.has(c.filePath));
      if (fileFiltered.length === 1) return toSymbol(fileFiltered[0]);

      // Step 2: narrow by ownerId == receiver type's nodeId(s); unique → resolve.
      const pool = fileFiltered.length > 0 ? fileFiltered : methodPool;
      const ownerFiltered = pool.filter((c) => c.ownerId !== undefined && typeNodeIds.has(c.ownerId));
      if (ownerFiltered.length === 1) return toSymbol(ownerFiltered[0]);

      // Refuse on ambiguity after narrowing (member path): emit no edge.
      if (fileFiltered.length > 1 || ownerFiltered.length > 1) return undefined;
    }
  }

  // ── Task 5: general-path refuse-on-ambiguity. Require exactly one survivor. ──
  if (filteredCandidates.length !== 1) return undefined;
  return toSymbol(filteredCandidates[0]);
}

/**
 * The PARITY selector. Identical to the inline logic `resolveHints` used before
 * E1: tiered first-candidate → same-file refinement → global name fallback
 * (first non-caller). Shared by every resolver so `single` and `mro` agree on the
 * baseline; `mro` only ADDS an ancestor-chain attempt ahead of this fallback.
 *
 * Wave 4: when `deps.refuseAmbiguous` is on, delegates to {@link selectFiltered}
 * (callable-kind + arity + receiver-type filtering, single-survivor-or-nothing).
 * When off (the default), runs the byte-identical legacy path below.
 */
export function selectSingle(
  input: CallResolutionInput,
  deps: CallResolutionDeps,
): Symbol | undefined {
  if (deps.refuseAmbiguous) return selectFiltered(input, deps);

  const { calleeName, caller, sourceFile } = input;
  const { ctx, symbolById, symbolMap } = deps;
  const ctxResult = ctx.resolve(calleeName, sourceFile);
  const resolvedId = ctxResult?.candidates[0]?.nodeId;
  const sameFile = resolvedId ? symbolById.get(resolvedId) : undefined;
  if (sameFile && sameFile.id !== caller.id) return sameFile;
  return (symbolMap.get(calleeName) ?? []).find((s) => s.id !== caller.id);
}

// ─── Registry ────────────────────────────────────────────────────────────────

const resolvers = new Map<Language | "default", ScopeResolver>();

/** Register a resolver (idempotent; last registration wins). */
export function registerScopeResolver(resolver: ScopeResolver): void {
  resolvers.set(resolver.language, resolver);
}

/**
 * Look up the resolver for a language, falling back to the `default`
 * (`single`-strategy, parity) resolver. Guaranteed non-null once the built-in
 * resolvers are registered (see `./resolvers/index.ts`, imported for side effect
 * by `resolution/index.ts`).
 */
export function getScopeResolver(language: Language): ScopeResolver {
  return resolvers.get(language) ?? resolvers.get("default") ?? DEFAULT_RESOLVER;
}

/** The parity default — also the registry fallback if nothing is registered. */
export const DEFAULT_RESOLVER: ScopeResolver = {
  language: "default",
  strategy: "single",
  propagatesReturnTypes: false,
  selectCallTarget: selectSingle,
};

registerScopeResolver(DEFAULT_RESOLVER);
