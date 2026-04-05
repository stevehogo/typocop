import { readFile, readdir } from "node:fs/promises";
import { join, relative, basename } from "node:path";

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
/** Strip single-line (//) and multi-line (block) comments from a JSON string. */
function stripJsonComments(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}
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

        // Normalise: strip all trailing glob stars from alias key and target value
        const normKey = key.replace(/\*+$/, "");
        const normTarget = target.replace(/\*+$/, "");
        aliases.set(normKey, normTarget);
      }

      if (aliases.size === 0) continue;

      return { aliases, baseUrl };
    } catch {
      // Missing file, unreadable, or parse error — try next candidate
    }
  }

  return null;
}

/** Normalise a PSR-4 namespace key: strip all trailing backslashes. */
function normaliseNamespaceKey(key: string): string {
  return key.replace(/\\+$/, "");
}

/** Normalise a PSR-4 directory value: strip trailing slashes, convert backslashes to forward slashes. */
function normaliseDirectoryValue(value: string): string {
  const forward = value.replace(/\\/g, "/");
  return forward.replace(/\/+$/, "");
}

export async function loadComposerConfig(repoRoot: string): Promise<ComposerConfig | null> {
  try {
    const raw = await readFile(join(repoRoot, "composer.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== "object" || parsed === null) return null;

    const composer = parsed as Record<string, unknown>;

    const psr4 = new Map<string, string>();

    // Helper to merge a psr-4 section into the map
    const mergePsr4 = (section: unknown): void => {
      if (typeof section !== "object" || section === null) return;
      for (const [key, val] of Object.entries(section as Record<string, unknown>)) {
        if (typeof val !== "string") continue;
        psr4.set(normaliseNamespaceKey(key), normaliseDirectoryValue(val));
      }
    };

    // Merge prod first, then dev (dev overrides prod for same key)
    const autoload = composer["autoload"];
    if (typeof autoload === "object" && autoload !== null) {
      mergePsr4((autoload as Record<string, unknown>)["psr-4"]);
    }

    const autoloadDev = composer["autoload-dev"];
    if (typeof autoloadDev === "object" && autoloadDev !== null) {
      mergePsr4((autoloadDev as Record<string, unknown>)["psr-4"]);
    }

    if (psr4.size === 0) return null;

    return { psr4 };
  } catch {
    return null;
  }
}

export async function loadGoModulePath(repoRoot: string): Promise<GoModuleConfig | null> {
  try {
    const raw = await readFile(join(repoRoot, "go.mod"), "utf-8");
    const match = raw.match(/^module\s+(\S+)/m);
    if (!match) return null;
    const modulePath = match[1];
    if (!modulePath) return null;
    return { modulePath };
  } catch {
    return null;
  }
}

const MAX_DEPTH = 5;
const MAX_DIRS = 100;
const CSPROJ_NAMESPACE_RE = /<RootNamespace>([^<]+)<\/RootNamespace>/;
const SKIP_DIRS = new Set(["node_modules", ".git", "bin", "obj"]);

export async function loadCSharpProjectConfig(repoRoot: string): Promise<readonly CSharpProjectConfig[]> {
  try {
    const results: CSharpProjectConfig[] = [];
    const queue: Array<{ dir: string; depth: number }> = [{ dir: repoRoot, depth: 0 }];
    let dirsVisited = 0;

    while (queue.length > 0) {
      const entry = queue.shift();
      if (!entry) break;
      const { dir, depth } = entry;

      if (dirsVisited >= MAX_DIRS) break;
      dirsVisited++;

      let entries: Awaited<ReturnType<typeof readdir>>;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const dirent of entries) {
        if (dirent.isDirectory()) {
          if (!SKIP_DIRS.has(dirent.name) && depth < MAX_DEPTH) {
            queue.push({ dir: join(dir, dirent.name), depth: depth + 1 });
          }
        } else if (dirent.isFile() && dirent.name.endsWith(".csproj")) {
          const filePath = join(dir, dirent.name);
          let content: string;
          try {
            content = await readFile(filePath, "utf-8");
          } catch {
            continue;
          }
          const match = content.match(CSPROJ_NAMESPACE_RE);
          const rootNamespace = match?.[1] ?? basename(dirent.name, ".csproj");
          const projectDir = relative(repoRoot, dir).replace(/\\/g, "/");
          results.push({ rootNamespace, projectDir });
        }
      }
    }

    return results;
  } catch {
    return [];
  }
}

const SWIFT_SOURCE_DIRS = ["Sources", "Package/Sources", "src"] as const;

export async function loadSwiftPackageConfig(repoRoot: string): Promise<SwiftPackageConfig | null> {
  try {
    const targets = new Map<string, string>();

    for (const sourceDir of SWIFT_SOURCE_DIRS) {
      let entries: Awaited<ReturnType<typeof readdir>>;
      try {
        entries = await readdir(join(repoRoot, sourceDir), { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry.isDirectory()) {
          targets.set(entry.name, `${sourceDir}/${entry.name}`);
        }
      }
    }

    if (targets.size === 0) return null;

    return { targets };
  } catch {
    return null;
  }
}

export async function loadLanguageConfigs(repoRoot: string): Promise<LanguageConfigs> {
  try {
    const [tsconfig, composer, goModule, csharp, swift] = await Promise.all([
      loadTsconfigPaths(repoRoot),
      loadComposerConfig(repoRoot),
      loadGoModulePath(repoRoot),
      loadCSharpProjectConfig(repoRoot),
      loadSwiftPackageConfig(repoRoot),
    ]);
    return { tsconfig, composer, goModule, csharp: csharp ?? [], swift };
  } catch {
    return { tsconfig: null, composer: null, goModule: null, csharp: [], swift: null };
  }
}
