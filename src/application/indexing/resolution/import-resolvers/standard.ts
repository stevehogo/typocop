/**
 * Standard import-path resolution (Wave 1).
 *
 * Ported from the legacy parser's `resolvers/standard.ts`. Handles
 * relative imports (`./`, `../`), TS/JS tsconfig path-alias rewriting, Python
 * PEP-328 dotted relatives, and generic suffix matching. Used as the fallback
 * when language-specific resolvers don't match.
 *
 * Vocabulary remap (README convention #2): the legacy parser's `SupportedLanguages` enum
 * comparisons become typocop's lowercase `Language` string union, and the
 * TS-alias `TsconfigPaths` is typocop's `language-config.ts` shape
 * (`{ aliases: ReadonlyMap, baseUrl }`) so the already-loaded config flows in.
 */
import type { Language } from "../../../../core/domain.js";
import type { TsconfigPaths } from "../../language-config.js";
import type { SuffixIndex } from "./utils.js";
import { tryResolveWithExtensions, suffixResolve } from "./utils.js";

/** Max entries in the resolve cache. Beyond this, the oldest 20% are evicted.
 *  100K entries ≈ 15MB — covers the most common import patterns. */
export const RESOLVE_CACHE_CAP = 100_000;

/**
 * Resolve an import path to a file path in the repository.
 *
 * Language-specific preprocessing is applied before the generic resolution:
 * - TypeScript/JavaScript: rewrites tsconfig path aliases
 *
 * Java wildcards and Go package imports are handled separately in the dispatch
 * (they resolve to multiple files / a package directory).
 *
 * Wave 7: Rust `crate::`/grouped-import preprocessing belongs here (the legacy
 * parser has a `resolveRustImport` branch); deferred until the Rust resolver is ported.
 */
export const resolveImportPath = (
  currentFile: string,
  importPath: string,
  allFiles: Set<string>,
  allFileList: string[],
  normalizedFileList: string[],
  resolveCache: Map<string, string | null>,
  language: Language,
  tsconfigPaths: TsconfigPaths | null,
  index?: SuffixIndex,
): string | null => {
  const cacheKey = `${currentFile}::${importPath}`;
  if (resolveCache.has(cacheKey)) return resolveCache.get(cacheKey) ?? null;

  const cache = (result: string | null): string | null => {
    // Evict the oldest 20% when the cap is reached instead of clearing all.
    if (resolveCache.size >= RESOLVE_CACHE_CAP) {
      const evictCount = Math.floor(RESOLVE_CACHE_CAP * 0.2);
      const iter = resolveCache.keys();
      for (let i = 0; i < evictCount; i++) {
        const key = iter.next().value;
        if (key !== undefined) resolveCache.delete(key);
      }
    }
    resolveCache.set(cacheKey, result);
    return result;
  };

  // ---- TypeScript/JavaScript: rewrite path aliases ----
  if (
    (language === "typescript" || language === "javascript") &&
    tsconfigPaths &&
    !importPath.startsWith(".")
  ) {
    for (const [aliasPrefix, targetPrefix] of tsconfigPaths.aliases) {
      if (importPath.startsWith(aliasPrefix)) {
        const remainder = importPath.slice(aliasPrefix.length);
        // Build the rewritten path relative to baseUrl.
        const rewritten =
          tsconfigPaths.baseUrl === "."
            ? targetPrefix + remainder
            : tsconfigPaths.baseUrl + "/" + targetPrefix + remainder;

        // Try direct resolution from repo root.
        const resolved = tryResolveWithExtensions(rewritten, allFiles);
        if (resolved) return cache(resolved);

        // Try suffix matching as a fallback.
        const parts = rewritten.split("/").filter(Boolean);
        const suffixResult = suffixResolve(parts, normalizedFileList, allFileList, index);
        if (suffixResult) return cache(suffixResult);
      }
    }
  }

  // Wave 7: rust crate::/super::/self:: + grouped-import preprocessing.

  // ---- Python relative imports (PEP 328): .module, ..module, ... ----
  if (language === "python" && importPath.startsWith(".")) {
    const dotMatch = importPath.match(/^(\.+)(.*)/);
    if (dotMatch) {
      const dotCount = dotMatch[1].length;
      const modulePart = dotMatch[2]; // e.g. "models" from ".models"
      const dirParts = currentFile.split("/").slice(0, -1); // drop filename

      // Navigate up: 1 dot = same package, each additional dot goes up a level.
      for (let i = 1; i < dotCount; i++) dirParts.pop();

      if (modulePart) {
        // from .models import User → resolve "models" relative to the package
        const modulePath = modulePart.replace(/\./g, "/");
        dirParts.push(...modulePath.split("/"));
      }

      const basePath = dirParts.join("/");
      // Python relatives never fall through (return even on null).
      return cache(tryResolveWithExtensions(basePath, allFiles));
    }
  }

  // ---- Generic relative import resolution (./ and ../) ----
  const currentDir = currentFile.split("/").slice(0, -1);
  const parts = importPath.split("/");

  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") currentDir.pop();
    else currentDir.push(part);
  }

  const basePath = currentDir.join("/");

  if (importPath.startsWith(".")) {
    return cache(tryResolveWithExtensions(basePath, allFiles));
  }

  // ---- Generic package/absolute import resolution (suffix matching) ----
  // Java wildcards are handled in the dispatch, not here.
  if (importPath.endsWith(".*")) return cache(null);

  // C/C++ includes use literal file paths (e.g. "animal.h") — don't convert
  // dots to slashes. (Wave 7 covers C/C++ dispatch; the guard is harmless now.)
  const isCpp = language === "c" || language === "cpp";
  const pathLike =
    importPath.includes("/") || isCpp ? importPath : importPath.replace(/\./g, "/");
  const pathParts = pathLike.split("/").filter(Boolean);

  return cache(suffixResolve(pathParts, normalizedFileList, allFileList, index));
};
