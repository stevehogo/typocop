/**
 * Java scope resolver (E1).
 *
 * Single class inheritance + multiple interface implementation (default methods
 * create interface-method ambiguity, handled additively by `../mro.ts`'s
 * methodImplements emission). Return types are statically declared → chain
 * binding enabled.
 */
import type { ScopeResolver } from "../scope-resolver.js";
import { selectSingle } from "../scope-resolver.js";

export const javaResolver: ScopeResolver = {
  language: "java",
  strategy: "mro",
  propagatesReturnTypes: true,
  selectCallTarget: selectSingle,
};
