/**
 * Per-language type-extractor dispatch (Wave 3, Tier B).
 *
 * Ported from the legacy parser (typocop's pre-refactor parser lineage), re-keyed
 * from the legacy `SupportedLanguages` enum to typocop's lowercase `Language`
 * union (`c_sharp`→`csharp`, etc.).
 *
 * REGISTERED THIS WAVE (the 5 langs whose typocop resolvers declare
 * `propagatesReturnTypes: true`, so the receiver types they produce flow through
 * the existing chain path with zero resolver changes): typescript, javascript,
 * python, go, java, php.
 *
 * ── Wave 7 seam ────────────────────────────────────────────────────────────
 * The legacy parser also ships configs for Kotlin, C#, Rust, Swift, C/C++, and
 * Ruby. They are deliberately NOT ported/registered here — Wave 3 ships Tier B
 * for the 5 languages above only (plan §3 / §4). Reviving them is Wave 7 §3.2
 * (PARKED). When revived: port `extractors/{kotlin,csharp,rust,swift,c-cpp,ruby}.ts`
 * and add their keys below. An unregistered language returns `undefined` from
 * {@link typeConfigs} and {@link buildTypeEnv} no-ops gracefully (the in-pass
 * guard in `extract-symbols.ts` also gates on `typeConfigs[language] !==
 * undefined`).
 */
import type { Language } from "../../../../core/domain.js";
import type { LanguageTypeConfig } from "../types.js";

import { typescriptConfig } from "./typescript.js";
import { pythonConfig } from "./python.js";
import { goConfig } from "./go.js";
import { javaConfig } from "./java.js";
import { phpConfig } from "./php.js";

/**
 * Dispatch map keyed by typocop `Language`. A `Partial<Record<...>>` because only
 * the 5 registered languages have a config; the rest resolve to `undefined`.
 * TS+JS share `typescriptConfig` (JS still gains constructor-call inference; the
 * `javascript` resolver's `propagatesReturnTypes: false` only disables the chain
 * threading downstream).
 */
export const typeConfigs: Partial<Record<Language, LanguageTypeConfig>> = {
  typescript: typescriptConfig,
  javascript: typescriptConfig,
  python: pythonConfig,
  go: goConfig,
  java: javaConfig,
  php: phpConfig,
  // ── Wave 7 §3.2 (PARKED) — unregistered: csharp, rust, swift, cpp, c, ruby, kotlin
};

export type {
  LanguageTypeConfig, TypeBindingExtractor, ParameterExtractor,
  ConstructorBindingScanner, ReturnTypeExtractor, InitializerExtractor, ClassNameLookup,
} from "../types.js";
export {
  TYPED_PARAMETER_TYPES,
  extractSimpleTypeName,
  extractGenericTypeArgs,
  extractVarName,
  findChildByType,
  extractRubyConstructorAssignment,
} from "../shared.js";
