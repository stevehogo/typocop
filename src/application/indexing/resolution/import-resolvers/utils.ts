/**
 * Shared utilities for import-path resolution (Wave 1).
 *
 * Ported verbatim from grapuco-cli `src/parser/ingestion/resolvers/utils.ts`
 * (typocop's pre-refactor parser lineage). Pure functions over plain strings /
 * Sets — no tree-sitter, no I/O. Builds an O(1)-ish path-suffix index for
 * `endsWith`-style import resolution.
 */

/** All file extensions to try during resolution (probed in array order). */
export const EXTENSIONS = [
  "",
  // TypeScript/JavaScript
  // (`.js`/`.mjs`/`.cjs` + their /index variants were absent from grapuco's
  // table — added so plain JS relative imports `./right` → `right.js` resolve.)
  ".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", "",
  "/index.tsx", "/index.ts", "/index.jsx", "/index.js", "/index",
  // Python
  ".py", "/__init__.py",
  // Java
  ".java",
  // Kotlin (kept harmless for Wave 7 — typocop has no `kotlin` Language yet)
  ".kt", ".kts",
  // C/C++
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".hxx", ".hh",
  // C#
  ".cs",
  // Go
  ".go",
  // Rust
  ".rs", "/mod.rs",
  // PHP
  ".php", ".phtml",
  // Swift
  ".swift",
  // Ruby
  ".rb",
];

/**
 * Try to match a base path (with each known extension appended) against the
 * known file set. Returns the matched file path or null.
 */
export function tryResolveWithExtensions(
  basePath: string,
  allFiles: Set<string>,
): string | null {
  for (const ext of EXTENSIONS) {
    const candidate = basePath + ext;
    if (allFiles.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Suffix index for fast `endsWith` lookups. Maps every path suffix of every
 * file to its original path.
 *
 * e.g. for "src/com/example/Foo.java":
 *   "Foo.java"             -> "src/com/example/Foo.java"
 *   "example/Foo.java"     -> "src/com/example/Foo.java"
 *   "com/example/Foo.java" -> "src/com/example/Foo.java"
 */
export interface SuffixIndex {
  /** Exact suffix lookup (case-sensitive). */
  get(suffix: string): string | undefined;
  /** Case-insensitive suffix lookup. */
  getInsensitive(suffix: string): string | undefined;
  /** Get all files directly in a directory suffix with a given extension. */
  getFilesInDir(dirSuffix: string, extension: string): string[];
}

export function buildSuffixIndex(normalizedFileList: string[], allFileList: string[]): SuffixIndex {
  // suffix -> original file path
  const exactMap = new Map<string, string>();
  // lowercased suffix -> original file path
  const lowerMap = new Map<string, string>();
  // "{dirSuffix}:{ext}" -> list of file paths in that directory
  const dirMap = new Map<string, string[]>();

  for (let i = 0; i < normalizedFileList.length; i++) {
    const normalized = normalizedFileList[i];
    const original = allFileList[i];
    const parts = normalized.split("/");

    // Index every suffix: "a/b/c.java" -> ["c.java", "b/c.java", "a/b/c.java"]
    for (let j = parts.length - 1; j >= 0; j--) {
      const suffix = parts.slice(j).join("/");
      // First write wins (longest path wins for ambiguous suffixes).
      if (!exactMap.has(suffix)) exactMap.set(suffix, original);
      const lower = suffix.toLowerCase();
      if (!lowerMap.has(lower)) lowerMap.set(lower, original);
    }

    // Index directory membership.
    const lastSlash = normalized.lastIndexOf("/");
    if (lastSlash >= 0) {
      const dirParts = parts.slice(0, -1);
      const fileName = parts[parts.length - 1];
      const ext = fileName.substring(fileName.lastIndexOf("."));

      for (let j = dirParts.length - 1; j >= 0; j--) {
        const dirSuffix = dirParts.slice(j).join("/");
        const key = `${dirSuffix}:${ext}`;
        let list = dirMap.get(key);
        if (!list) {
          list = [];
          dirMap.set(key, list);
        }
        list.push(original);
      }
    }
  }

  return {
    get: (suffix: string) => exactMap.get(suffix),
    getInsensitive: (suffix: string) => lowerMap.get(suffix.toLowerCase()),
    getFilesInDir: (dirSuffix: string, extension: string) =>
      dirMap.get(`${dirSuffix}:${extension}`) ?? [],
  };
}

/**
 * Suffix-based resolution. With an index, O(1) per lookup; otherwise falls back
 * to a linear `endsWith` scan. Walks suffixes from most-qualified to bare
 * filename, trying each extension; first match wins.
 */
export function suffixResolve(
  pathParts: string[],
  normalizedFileList: string[],
  allFileList: string[],
  index?: SuffixIndex,
): string | null {
  if (index) {
    for (let i = 0; i < pathParts.length; i++) {
      const suffix = pathParts.slice(i).join("/");
      for (const ext of EXTENSIONS) {
        const suffixWithExt = suffix + ext;
        const result = index.get(suffixWithExt) ?? index.getInsensitive(suffixWithExt);
        if (result) return result;
      }
    }
    return null;
  }

  // Fallback: linear scan (no index).
  for (let i = 0; i < pathParts.length; i++) {
    const suffix = pathParts.slice(i).join("/");
    for (const ext of EXTENSIONS) {
      const suffixWithExt = suffix + ext;
      const suffixPattern = "/" + suffixWithExt;
      const matchIdx = normalizedFileList.findIndex(
        (filePath) =>
          filePath.endsWith(suffixPattern) ||
          filePath.toLowerCase().endsWith(suffixPattern.toLowerCase()),
      );
      if (matchIdx !== -1) return allFileList[matchIdx];
    }
  }
  return null;
}
