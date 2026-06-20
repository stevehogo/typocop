/**
 * PHP scope resolver (E1).
 *
 * Single class inheritance + interfaces + trait composition. Traits are folded
 * into the ancestor set for MRO purposes. PHP return-type declarations enable
 * chain binding.
 */
import type { ScopeResolver } from "../scope-resolver.js";
import { selectSingle } from "../scope-resolver.js";

export const phpResolver: ScopeResolver = {
  language: "php",
  strategy: "mro",
  propagatesReturnTypes: true,
  selectCallTarget: selectSingle,
};
