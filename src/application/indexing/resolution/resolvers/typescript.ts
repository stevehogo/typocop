/**
 * TypeScript/JavaScript scope resolver (E1).
 *
 * Single-dispatch language with class inheritance + interface implementation.
 * Uses the shared parity selector (`selectSingle`) as the FALLBACK; the `mro`
 * strategy flag enables the additive ancestor-chain attempt in `resolveHints`
 * (step 4) ahead of that fallback, and `propagatesReturnTypes` enables chain
 * binding (`a.getB().getC()`, step 5). The fallback path is byte-identical to
 * pre-E1, so golden tests hold.
 */
import type { ScopeResolver } from "../scope-resolver.js";
import { selectSingle } from "../scope-resolver.js";

export const typescriptResolver: ScopeResolver = {
  language: "typescript",
  strategy: "mro",
  propagatesReturnTypes: true,
  selectCallTarget: selectSingle,
};

export const javascriptResolver: ScopeResolver = {
  language: "javascript",
  strategy: "mro",
  // JS has no static return-type annotations; chain binding is a no-op, so leave
  // it off to avoid wasted work.
  propagatesReturnTypes: false,
  selectCallTarget: selectSingle,
};
