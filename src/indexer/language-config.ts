import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

// ============================================================================
// Interfaces
// ============================================================================

/** TypeScript path alias config parsed from tsconfig.json */
export interface TsconfigPaths {
  readonly aliases: ReadonlyMap<string, string>;
  readonly baseUrl: string;
}

/** PHP Composer PSR-4 autoload config */
export interface ComposerConfig {
  readonly psr4: ReadonlyMap<string, string>;
}

/** Go module config parsed from go.mod */
export interface GoModuleConfig {
  readonly modulePath: string;
}

/** C# project config parsed from a single .csproj file */
export interface CSharpProjectConfig {
  readonly rootNamespace: string;
  readonly projectDir: string;
}

/** Swift Package Manager target config */
export interface SwiftPackageConfig {
  readonly targets: ReadonlyMap<string, string>;
}

/** Aggregate result of all five language config loaders */
export interface LanguageConfigs {
  readonly tsconfig: TsconfigPaths | null;
  readonly composer: ComposerConfig | null;
  readonly goModule: GoModuleConfig | null;
  readonly csharp: readonly CSharpProjectConfig[];
  readonly swift: SwiftPackageConfig | null;
}

// ============================================================================
// Helpers
// ============================================================================

/** Strip single-line (//) and multi-line (block) comments from a JSON string. */
function stripJsonComments(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

// ============================================================================
// Public functions
// ============================================================================

const TSCONFIG_CANDIDATES = ["tsconfig.json", "tsconfig.app.json", "tsconfig.base.json"] as const;

export async function loadTsconfigPaths(repoRoot: string): Promise<TsconfigPaths | null> {
  for (const filename of TSCONFIG_CANDIDATES) {
    try {
      const raw = await readFile(join(repoRoot, filename), "utf-8");
      const tsconfig: unknown = JSON.parse(stripJsonComments(raw));

      if (
        typeof tsconfig !== "object" ||
        tsconfig === null ||
        !("compilerOptions" in tsconfig)
      ) continue;

      const opts = (tsconfig as Record<string, unknown>).compilerOptions;
      if (typeof opts !== "object" || opts === null || !("paths" in opts)) continue;

      const rawPaths = (opts as Record<string, unknown>).paths;
      if (typeof rawPaths !== "object" || rawPaths === null) continue;

      const baseUrl =
        typeof (opts as Record<string, unknown>).baseUrl === "string"
          ? ((opts as Record<string, unknown>).baseUrl as string)
          : ".";

      const aliases = new Map<string, string>();

      for (const [key, val] of Object.entries(rawPaths as Record<string, unknown>)) {
        if (!Array.isArray(val) || val.length === 0) continue;
        const target = val[0];
        if (typeof target !== "string") continue;

        // Normalise: strip trailing glob star from alias key and target value (req 1.3)
        const normKey = key.endsWith("*") ? key.slice(0, -1) : key;
        const normTarget = target.endsWith("*") ? target.slice(0, -1) : target;
        aliases.set(normKey, normTarget);
      }

      if (aliases.size === 0) continue;

      return { aliases, baseUrl };
    } catch {
      // Missing file, unreadable, or parse error — try next candidate (req 1.5, 1.6)
    }
  }

  return null;
}

export async function loadComposerConfig(repoRoot: string): Promise<ComposerConfig | null> {
  throw new Error("not implemented");
}

export async function loadGoModulePath(repoRoot: string): Promise<GoModuleConfig | null> {
  throw new Error("not implemented");
}

export async function loadCSharpProjectConfig(repoRoot: string): Promise<readonly CSharpProjectConfig[]> {
  throw new Error("not implemented");
}

export async function loadSwiftPackageConfig(repoRoot: string): Promise<SwiftPackageConfig | null> {
  throw new Error("not implemented");
}

export async function loadLanguageConfigs(repoRoot: string): Promise<LanguageConfigs> {
  throw new Error("not implemented");
}
