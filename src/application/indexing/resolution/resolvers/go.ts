/**
 * Go scope resolver (E1).
 *
 * Go has no class inheritance — it uses struct embedding + structural interface
 * satisfaction. There is no linearised MRO to walk, so Go stays on the parity
 * `single` strategy. Embedding-derived `inherits` edges (already produced by the
 * heritage query) feed the MRO ancestor map but Go emits no `overrides` edges.
 * Return types are declared, so chain binding is enabled.
 */
import type { ScopeResolver } from "../scope-resolver.js";
import { selectSingle } from "../scope-resolver.js";

export const goResolver: ScopeResolver = {
  language: "go",
  strategy: "single",
  propagatesReturnTypes: true,
  selectCallTarget: selectSingle,
};
