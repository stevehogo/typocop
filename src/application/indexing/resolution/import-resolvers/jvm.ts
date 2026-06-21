/**
 * JVM (Java) import resolution (Wave 1).
 *
 * Ported from grapuco-cli `src/parser/ingestion/resolvers/jvm.ts`, restricted to
 * Java (`.java`). grapuco's Kotlin support (`KOTLIN_EXTENSIONS`,
 * `appendKotlinWildcard`, the Kotlin→Java cross-language fallback) is a
 * ── Wave 7 seam ── : typocop's `Language` union has no `"kotlin"` member yet,
 * so this port resolves Java only.
 *
 * - Wildcard `com.example.*` → all `.java` files directly in that package dir.
 * - Member/static import `com.example.Constants.VALUE` → strip the member, then
 *   resolve the enclosing class file `com/example/Constants.java`.
 */
import type { SuffixIndex } from "./utils.js";

/** Java source extension(s). Kept as an array to mirror grapuco's `extensions` param. */
const JAVA_EXTENSIONS: readonly string[] = [".java"];

/**
 * Resolve a Java wildcard import (`com.example.*`) to all `.java` files directly
 * in the matching package directory (no subdirectories).
 */
export function resolveJvmWildcard(
  importPath: string,
  normalizedFileList: string[],
  allFileList: string[],
  index?: SuffixIndex,
): string[] {
  // "com.example.util.*" -> "com/example/util"
  const packagePath = importPath.slice(0, -2).replace(/\./g, "/");
  const packageSuffix = "/" + packagePath + "/";

  if (index) {
    const candidates = JAVA_EXTENSIONS.flatMap((ext) => index.getFilesInDir(packagePath, ext));
    // Filter to direct children (no subdirectories).
    return candidates.filter((f) => {
      const normalized = f.replace(/\\/g, "/");
      const idx = normalized.indexOf(packageSuffix);
      if (idx < 0) return false;
      const afterPkg = normalized.substring(idx + packageSuffix.length);
      return !afterPkg.includes("/");
    });
  }

  // Fallback: linear scan.
  const matches: string[] = [];
  for (let i = 0; i < normalizedFileList.length; i++) {
    const normalized = normalizedFileList[i];
    if (
      normalized.includes(packageSuffix) &&
      JAVA_EXTENSIONS.some((ext) => normalized.endsWith(ext))
    ) {
      const afterPackage = normalized.substring(
        normalized.indexOf(packageSuffix) + packageSuffix.length,
      );
      if (!afterPackage.includes("/")) matches.push(allFileList[i]);
    }
  }
  return matches;
}

/**
 * Resolve a Java member/static import by stripping the trailing member name.
 * `com.example.Constants.VALUE` → resolve the class `com.example.Constants`.
 * The last segment is treated as a member when it is a wildcard, starts
 * lowercase, or is ALL_CAPS.
 */
export function resolveJvmMemberImport(
  importPath: string,
  normalizedFileList: string[],
  allFileList: string[],
  index?: SuffixIndex,
): string | null {
  const segments = importPath.split(".");
  if (segments.length < 3) return null;

  const lastSeg = segments[segments.length - 1];
  if (lastSeg === "*" || /^[a-z]/.test(lastSeg) || /^[A-Z_]+$/.test(lastSeg)) {
    const classPath = segments.slice(0, -1).join("/");

    for (const ext of JAVA_EXTENSIONS) {
      const classSuffix = classPath + ext;
      if (index) {
        const result = index.get(classSuffix) ?? index.getInsensitive(classSuffix);
        if (result) return result;
      } else {
        const fullSuffix = "/" + classSuffix;
        for (let i = 0; i < normalizedFileList.length; i++) {
          if (
            normalizedFileList[i].endsWith(fullSuffix) ||
            normalizedFileList[i].toLowerCase().endsWith(fullSuffix.toLowerCase())
          ) {
            return allFileList[i];
          }
        }
      }
    }
  }

  return null;
}
