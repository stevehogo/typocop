/**
 * Chain binding (E1 step 5).
 *
 * Resolves chained member calls `a.getB().getC()` by threading return types:
 * `a`'s type → `getB`'s `returnType` → `getC`'s `returnType`. Gated on the
 * resolver's `propagatesReturnTypes` flag (so languages without static return
 * types skip the work entirely). PURELY ADDITIVE — if a link can't be threaded,
 * resolution falls back to the parity selector unchanged.
 *
 * v1 scope: resolve the type of a receiver expression to a class/struct symbol id
 * by following declared return types one hop at a time. The receiver text is the
 * raw `recv` capture (`extractReceiverText`); a leading `this`/`self` binds to the
 * caller's owner type.
 */
import type { Symbol } from "../../../core/domain.js";

export interface ChainBindingDeps {
  /** id → Symbol. */
  readonly symbolById: ReadonlyMap<string, Symbol>;
  /** name → Symbol[] (for resolving a type name to its class symbol). */
  readonly symbolMap: ReadonlyMap<string, Symbol[]>;
  /** ownerId → methods owned by that type. */
  readonly methodsByOwner: ReadonlyMap<string, Symbol[]>;
}

/** Strip generics/decorations to a bare type name (`Promise<User>` → `User`). */
export function bareTypeName(returnType: string): string | undefined {
  const trimmed = returnType.trim();
  // Unwrap a single Promise<...>/Array<...>/... wrapper to the inner type.
  const generic = trimmed.match(/^[A-Za-z_$][\w$]*<\s*(.+?)\s*>$/);
  const inner = generic ? generic[1] : trimmed;
  // Take the leading identifier of the (possibly wrapped) type.
  const id = inner.match(/^[A-Za-z_$][\w$.]*/);
  if (!id) return undefined;
  const segs = id[0].split(".");
  const name = segs[segs.length - 1];
  return name.length > 0 ? name : undefined;
}

/** Resolve a bare type NAME to its defining class/struct/interface symbol. */
function typeNameToSymbol(
  typeName: string,
  deps: ChainBindingDeps,
): Symbol | undefined {
  const candidates = deps.symbolMap.get(typeName) ?? [];
  return candidates.find(
    (s) => s.kind === "class" || s.kind === "interface",
  );
}

/**
 * Given the receiver type (a class symbol) and a method name, find that method's
 * declared return TYPE symbol — i.e. the next type in a chain. Returns the class
 * symbol the method returns, or `undefined` if it can't be threaded.
 */
export function stepChain(
  receiverType: Symbol,
  methodName: string,
  deps: ChainBindingDeps,
): Symbol | undefined {
  const methods = deps.methodsByOwner.get(receiverType.id) ?? [];
  const method = methods.find((m) => m.name === methodName);
  if (!method?.returnType) return undefined;
  const typeName = bareTypeName(method.returnType);
  if (!typeName) return undefined;
  return typeNameToSymbol(typeName, deps);
}

/**
 * Resolve the receiver TYPE of a (possibly chained) member call.
 *
 * `receiverText` is the raw receiver expression. Supported v1 forms:
 *   - `this` / `self`       → the caller's owner type
 *   - a single identifier   → if it names a class, that class (e.g. `User.x()`);
 *                             otherwise unresolved (local-variable types need
 *                             flow analysis, out of v1 scope)
 *   - `a.getB()`            → thread `getB`'s return type from `a`'s type
 *
 * Returns the resolved receiver type symbol, or `undefined`.
 */
export function resolveReceiverType(
  receiverText: string,
  caller: Symbol,
  deps: ChainBindingDeps,
): Symbol | undefined {
  const text = receiverText.trim();
  if (text === "this" || text === "self") {
    // `this` binds to the enclosing type. When the caller is itself a type
    // (the tiered caller-selection picks the outermost containing symbol, often
    // the class), that type IS the receiver; otherwise follow the method's owner.
    if (caller.kind === "class" || caller.kind === "interface") return caller;
    return caller.ownerId ? deps.symbolById.get(caller.ownerId) : undefined;
  }

  // Chained call segment: `<head>.<method>()` — recurse on the head, then step.
  const chain = text.match(/^(.*)\.([A-Za-z_$][\w$]*)\s*\(\s*\)$/);
  if (chain) {
    const [, head, method] = chain;
    const headType = resolveReceiverType(head, caller, deps);
    if (!headType) return undefined;
    return stepChain(headType, method, deps);
  }

  // `this.field` / `self.field`: field types need flow analysis — skip in v1.
  if (/^(this|self)\./.test(text)) return undefined;

  // Bare identifier that names a class (static-style `User.create()`).
  if (/^[A-Za-z_$][\w$]*$/.test(text)) {
    return typeNameToSymbol(text, deps);
  }

  return undefined;
}
