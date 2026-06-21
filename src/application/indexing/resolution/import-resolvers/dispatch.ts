/**
 * Per-language import-specifier dispatch (Wave 1).
 *
 * Ported from grapuco-cli `src/parser/ingestion/import-processor.ts`
 * `resolveLanguageImport` + the `ImportResult` type + `buildImportResolutionContext`.
 *
 * Routes a raw module specifier to the right resolver by `Language`:
 * - Java: wildcard / member / standard (suffix index).
 * - Go: package-directory resolution → `{ kind: "package" }`.
 * - PHP: PSR-4 longest-prefix + suffix fallback.
 * - TS/JS/Python and everything else: `resolveImportPath` (relative, alias,
 *   PEP-328, generic suffix).
 *
 * ── Wave 7 seam ──: rust / csharp / kotlin / swift / ruby get their own
 * dispatch branches in grapuco; they are intentionally NOT ported here (this
 * wave ships the 6 languages typocop already resolves). Their specifiers fall
 * through to `resolveImportPath`, which returns `null` for bare external
 * specifiers — never a wrong edge.
 */
import type { Language } from "../../../../core/domain.js";
import type { LanguageConfigs } from "../../language-config.js";
import type { SuffixIndex } from "./utils.js";
import { buildSuffixIndex } from "./utils.js";
import { resolveImportPath } from "./standard.js";
import { resolveGoPackage, resolveGoPackageDir } from "./go.js";
import { resolvePhpImport } from "./php.js";
import { resolveJvmMemberImport, resolveJvmWildcard } from "./jvm.js";

/**
 * Result of resolving an import via language dispatch.
 * - `files`: resolved to one or more files → add to ImportMap.
 * - `package`: resolved to a directory → store `dirSuffix` in PackageMap (and,
 *   per the pass's both-maps decision, the member `files` in ImportMap too).
 * - `null`: no resolution (external dependency, etc.).
 */
export type ImportResult =
  | { kind: "files"; files: string[] }
  | { kind: "package"; files: string[]; dirSuffix: string }
  | null;

/** File lists + indexes + cache for import-path resolution. Built once, reused. */
export interface ResolveCtx {
  readonly allFilePaths: Set<string>;
  readonly allFileList: string[];
  readonly normalizedFileList: string[];
  readonly index: SuffixIndex;
  readonly resolveCache: Map<string, string | null>;
}

/** Pre-built lookup structures for import resolution. Build once per run. */
export interface ImportResolutionContext {
  readonly allFilePaths: Set<string>;
  readonly allFileList: string[];
  readonly normalizedFileList: string[];
  readonly suffixIndex: SuffixIndex;
  readonly resolveCache: Map<string, string | null>;
}

export function buildImportResolutionContext(allPaths: readonly string[]): ImportResolutionContext {
  const allFileList = [...allPaths];
  const normalizedFileList = allFileList.map((p) => p.replace(/\\/g, "/"));
  const allFilePaths = new Set(allFileList);
  const suffixIndex = buildSuffixIndex(normalizedFileList, allFileList);
  return { allFilePaths, allFileList, normalizedFileList, suffixIndex, resolveCache: new Map() };
}

/**
 * Resolve a single import specifier to file(s) / a package / null.
 */
export function resolveImportSpecifier(
  filePath: string,
  rawSpecifier: string,
  language: Language,
  configs: LanguageConfigs,
  ctx: ResolveCtx,
): ImportResult {
  const { allFilePaths, allFileList, normalizedFileList, index, resolveCache } = ctx;
  const { tsconfig, goModule, composer } = configs;

  // ── Java: wildcards and member imports ──────────────────────────────────────
  // Wave 7: Kotlin shares this branch in grapuco (KOTLIN_EXTENSIONS + a
  // Kotlin→Java fallback); deferred until "kotlin" joins the Language union.
  if (language === "java") {
    if (rawSpecifier.endsWith(".*")) {
      const matchedFiles = resolveJvmWildcard(rawSpecifier, normalizedFileList, allFileList, index);
      if (matchedFiles.length > 0) return { kind: "files", files: matchedFiles };
      // Fall through to standard resolution.
    } else {
      const memberResolved = resolveJvmMemberImport(rawSpecifier, normalizedFileList, allFileList, index);
      if (memberResolved) return { kind: "files", files: [memberResolved] };
      // Fall through to standard resolution.
    }
  }

  // ── Go: package-level imports ───────────────────────────────────────────────
  if (language === "go" && goModule && rawSpecifier.startsWith(goModule.modulePath)) {
    const pkgSuffix = resolveGoPackageDir(rawSpecifier, goModule);
    if (pkgSuffix) {
      const pkgFiles = resolveGoPackage(rawSpecifier, goModule, normalizedFileList, allFileList);
      if (pkgFiles.length > 0) {
        return { kind: "package", files: pkgFiles, dirSuffix: pkgSuffix };
      }
    }
    // Fall through if no files found (package might be external).
  }

  // ── PHP: namespace-based imports (use statements) ───────────────────────────
  if (language === "php") {
    const resolved = resolvePhpImport(
      rawSpecifier,
      composer,
      allFilePaths,
      normalizedFileList,
      allFileList,
      index,
    );
    return resolved ? { kind: "files", files: [resolved] } : null;
  }

  // Wave 7: csharp (namespace dir), swift (SPM targets), ruby (require), rust
  // (grouped `use {...}`) dispatch branches go here.

  // ── Standard single-file resolution (TS/JS/Python + fall-through) ───────────
  const resolvedPath = resolveImportPath(
    filePath,
    rawSpecifier,
    allFilePaths,
    allFileList,
    normalizedFileList,
    resolveCache,
    language,
    tsconfig,
    index,
  );

  return resolvedPath ? { kind: "files", files: [resolvedPath] } : null;
}
