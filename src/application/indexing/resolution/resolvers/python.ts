/**
 * Python scope resolver (E1).
 *
 * Python supports multiple inheritance, so its MRO is computed by C3
 * linearization (see `../mro.ts`). The selection fallback stays the shared
 * parity selector; the `mro` strategy enables the additive C3 ancestor-chain
 * member-call attempt. Python's `-> T` return annotations enable chain binding.
 */
import type { ScopeResolver } from "../scope-resolver.js";
import { selectSingle } from "../scope-resolver.js";

export const pythonResolver: ScopeResolver = {
  language: "python",
  strategy: "mro",
  propagatesReturnTypes: true,
  selectCallTarget: selectSingle,
};
