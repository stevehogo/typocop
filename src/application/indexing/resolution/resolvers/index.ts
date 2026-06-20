/**
 * Built-in scope resolvers (E1). Importing this module registers every shipped
 * per-language resolver into the registry. `resolution/index.ts` imports it for
 * its side effect so `getScopeResolver(language)` always resolves to a concrete
 * (non-default) resolver for the five supported languages, and to the parity
 * `DEFAULT_RESOLVER` for everything else.
 */
import { registerScopeResolver } from "../scope-resolver.js";
import { typescriptResolver, javascriptResolver } from "./typescript.js";
import { pythonResolver } from "./python.js";
import { javaResolver } from "./java.js";
import { phpResolver } from "./php.js";
import { goResolver } from "./go.js";

registerScopeResolver(typescriptResolver);
registerScopeResolver(javascriptResolver);
registerScopeResolver(pythonResolver);
registerScopeResolver(javaResolver);
registerScopeResolver(phpResolver);
registerScopeResolver(goResolver);

export {
  typescriptResolver,
  javascriptResolver,
  pythonResolver,
  javaResolver,
  phpResolver,
  goResolver,
};
