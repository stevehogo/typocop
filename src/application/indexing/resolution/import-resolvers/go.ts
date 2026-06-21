/**
 * Go package import resolution (Wave 1).
 *
 * Ported from the legacy parser's `resolvers/go.ts`, reusing
 * typocop's `GoModuleConfig` (`{ modulePath }`).
 *
 * ─── PINNED DIR-SUFFIX CONVENTION (Tier 2b round-trip) ───────────────────────
 * typocop's Tier-2b matcher `isFileInPackageDir(filePath, dirSuffix)`
 * (named-binding.ts) tests `filePath.includes(`/${dirSuffix}/`) ||
 * filePath.endsWith(`/${dirSuffix}`)` — it wraps the suffix in `/.../` and
 * matches on path-segment boundaries, BUT it does NOT prepend a `/` to the
 * file path (the legacy parser's variant did). typocop file paths are cwd-RELATIVE
 * (e.g. `internal/auth/service.go`, no leading slash), so a multi-segment
 * suffix like `internal/auth` would never match a package that is itself the
 * leading path component.
 *
 * Pinned choice: `resolveGoPackageDir` returns the **trailing package
 * directory segment** (e.g. `auth` for module-relative pkg `internal/auth`).
 * Then `isFileInPackageDir("internal/auth/svc.go", "auth")` matches the
 * interior `/auth/` boundary for ANY relative path — a guaranteed round-trip.
 *
 * The precision cost (two packages whose trailing segment is `auth` both match
 * Tier 2b) is absorbed by the import-resolution pass writing every resolved
 * member `.go` file into the importMap as well: Tier 2a (exact member files)
 * runs BEFORE Tier 2b, so Tier 2b only ever acts as a backstop. See
 * import-resolution-pass.ts (the Go both-maps decision) and the round-trip test.
 */
import type { GoModuleConfig } from "../../language-config.js";

/**
 * Extract the package-directory suffix from a Go import path.
 * Returns the trailing package directory segment (e.g. "auth") or null.
 */
export function resolveGoPackageDir(
  importPath: string,
  goModule: GoModuleConfig,
): string | null {
  if (!importPath.startsWith(goModule.modulePath)) return null;
  const relativePkg = importPath.slice(goModule.modulePath.length + 1); // strip leading "/"
  if (!relativePkg) return null;
  // Trailing segment so the suffix round-trips through isFileInPackageDir for
  // cwd-relative file paths (which have no leading slash).
  const segments = relativePkg.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? null;
}

/**
 * Resolve a Go internal package import to all `.go` files directly in the
 * package directory (excluding `_test.go` and files in subdirectories).
 */
export function resolveGoPackage(
  importPath: string,
  goModule: GoModuleConfig,
  normalizedFileList: string[],
  allFileList: string[],
): string[] {
  if (!importPath.startsWith(goModule.modulePath)) return [];

  const relativePkg = importPath.slice(goModule.modulePath.length + 1); // e.g. "internal/auth"
  if (!relativePkg) return [];

  const pkgSuffix = "/" + relativePkg + "/";
  const matches: string[] = [];

  for (let i = 0; i < normalizedFileList.length; i++) {
    // Prepend "/" so paths like "internal/auth/service.go" match "/internal/auth/".
    const normalized = "/" + normalizedFileList[i];
    if (
      normalized.includes(pkgSuffix) &&
      normalized.endsWith(".go") &&
      !normalized.endsWith("_test.go")
    ) {
      const afterPkg = normalized.substring(normalized.indexOf(pkgSuffix) + pkgSuffix.length);
      // File must be DIRECTLY in the package dir (not a subdirectory).
      if (!afterPkg.includes("/")) matches.push(allFileList[i]);
    }
  }

  return matches;
}
