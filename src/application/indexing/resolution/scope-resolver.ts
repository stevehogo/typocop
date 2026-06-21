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
 */
import type { Language, Symbol } from "../../../core/domain.js";
import type { ResolutionContext } from "./resolution-context.js";

/** How a member/free call's target is chosen from tiered candidates. */
export type ResolveStrategy = "single" | "mro";

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
}

/** Lookups a selector may use — supplied by `resolveHints`, never imported. */
export interface CallResolutionDeps {
  readonly ctx: ResolutionContext;
  /** id → Symbol (tiered candidate ids are symbol ids). */
  readonly symbolById: ReadonlyMap<string, Symbol>;
  /** name → Symbol[] (global name fallback). */
  readonly symbolMap: ReadonlyMap<string, Symbol[]>;
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

/**
 * The PARITY selector. Identical to the inline logic `resolveHints` used before
 * E1: tiered first-candidate → same-file refinement → global name fallback
 * (first non-caller). Shared by every resolver so `single` and `mro` agree on the
 * baseline; `mro` only ADDS an ancestor-chain attempt ahead of this fallback.
 */
export function selectSingle(
  input: CallResolutionInput,
  deps: CallResolutionDeps,
): Symbol | undefined {
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
