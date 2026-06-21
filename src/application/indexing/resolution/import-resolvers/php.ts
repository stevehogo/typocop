/**
 * PHP PSR-4 import resolution (Wave 1).
 *
 * Ported from the legacy parser's `resolvers/php.ts`, reusing
 * typocop's `ComposerConfig` (`{ psr4: ReadonlyMap }`). Resolves `use`-statement
 * targets via composer PSR-4 autoload mappings (longest-prefix wins) with a
 * suffix-index fallback when no composer config is present.
 */
import type { ComposerConfig } from "../../language-config.js";
import type { SuffixIndex } from "./utils.js";
import { suffixResolve } from "./utils.js";

/**
 * Resolve a PHP use-statement import path.
 * e.g. "App\Http\Controllers\UserController" -> "app/Http/Controllers/UserController.php"
 */
export function resolvePhpImport(
  importPath: string,
  composerConfig: ComposerConfig | null,
  allFiles: Set<string>,
  normalizedFileList: string[],
  allFileList: string[],
  index?: SuffixIndex,
): string | null {
  // Normalize: backslashes → forward slashes.
  const normalized = importPath.replace(/\\/g, "/");

  // PSR-4 resolution if composer.json was found.
  if (composerConfig) {
    // Sort namespaces by key length descending (longest prefix wins).
    const sorted = [...composerConfig.psr4.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [nsPrefix, dirPrefix] of sorted) {
      const nsPrefixSlash = nsPrefix.replace(/\\/g, "/");
      if (normalized.startsWith(nsPrefixSlash + "/") || normalized === nsPrefixSlash) {
        const remainder = normalized.slice(nsPrefixSlash.length).replace(/^\//, "");
        const filePath = dirPrefix + (remainder ? "/" + remainder : "") + ".php";
        if (allFiles.has(filePath)) return filePath;
        if (index) {
          const result = index.getInsensitive(filePath);
          if (result) return result;
        }
      }
    }
  }

  // Fallback: suffix matching (works without composer.json).
  const pathParts = normalized.split("/").filter(Boolean);
  return suffixResolve(pathParts, normalizedFileList, allFileList, index);
}
