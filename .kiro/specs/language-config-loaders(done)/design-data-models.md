# Data Models & Algorithms — Language Config Loaders

Part of the [Language Config Loaders Design](./design.md).

## Data Models

### `TsconfigPaths`

```typescript
interface TsconfigPaths {
  /** alias prefix → target prefix, e.g. "@/" → "src/" */
  readonly aliases: ReadonlyMap<string, string>;
  /** baseUrl from compilerOptions, defaults to "." */
  readonly baseUrl: string;
}
```

Populated from `compilerOptions.paths` in `tsconfig.json` / `tsconfig.app.json` /
`tsconfig.base.json` (first file with a non-empty `paths` wins).

Glob patterns are normalised: `"@/*"` → `"@/"`, `"src/*"` → `"src/"`.

### `ComposerConfig`

```typescript
interface ComposerConfig {
  /** PSR-4 namespace prefix → directory, e.g. "App" → "app" */
  readonly psr4: ReadonlyMap<string, string>;
}
```

Merges `autoload["psr-4"]` and `autoload-dev["psr-4"]` from `composer.json`.
Trailing backslashes stripped from namespace keys; trailing slashes stripped from dirs.

### `GoModuleConfig`

```typescript
interface GoModuleConfig {
  /** e.g. "github.com/user/repo" */
  readonly modulePath: string;
}
```

Extracted from the first `module <path>` line in `go.mod`.

### `CSharpProjectConfig`

```typescript
interface CSharpProjectConfig {
  /** Value of <RootNamespace> or .csproj filename without extension */
  readonly rootNamespace: string;
  /** Path of the .csproj directory relative to repoRoot, forward-slash separated */
  readonly projectDir: string;
}
```

One entry per `.csproj` file found during BFS scan.

### `SwiftPackageConfig`

```typescript
interface SwiftPackageConfig {
  /** SPM target name → source directory, e.g. "MyLib" → "Sources/MyLib" */
  readonly targets: ReadonlyMap<string, string>;
}
```

Built by scanning `Sources/`, `Package/Sources/`, and `src/` for subdirectories.

---

## Algorithms

### `loadTsconfigPaths`

```pascal
PROCEDURE loadTsconfigPaths(repoRoot)
  INPUT: repoRoot: string
  OUTPUT: TsconfigPaths | null

  candidates ← ["tsconfig.json", "tsconfig.app.json", "tsconfig.base.json"]

  FOR each filename IN candidates DO
    TRY
      raw ← readFile(join(repoRoot, filename), "utf-8")
      stripped ← stripJsonComments(raw)
      tsconfig ← JSON.parse(stripped)
      paths ← tsconfig.compilerOptions?.paths
      IF paths IS NULL THEN CONTINUE END IF

      baseUrl ← tsconfig.compilerOptions.baseUrl OR "."
      aliases ← new Map()

      FOR each [pattern, targets] IN entries(paths) DO
        IF targets IS empty array THEN CONTINUE END IF
        aliasPrefix ← IF pattern ends with "/*" THEN pattern[0..-2] ELSE pattern
        targetPrefix ← IF targets[0] ends with "/*" THEN targets[0][0..-2] ELSE targets[0]
        aliases.set(aliasPrefix, targetPrefix)
      END FOR

      IF aliases.size > 0 THEN
        RETURN { aliases, baseUrl }
      END IF
    CATCH
      CONTINUE  // file absent or invalid JSON
    END TRY
  END FOR

  RETURN null
END PROCEDURE

PROCEDURE stripJsonComments(raw)
  INPUT: raw: string
  OUTPUT: string
  // Remove single-line comments: // ... to end of line
  // Remove multi-line comments: /* ... */
  RETURN raw
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
END PROCEDURE
```

**Preconditions:** `repoRoot` is an absolute path to a readable directory.
**Postconditions:** Returns `null` if no tsconfig with `paths` is found. Otherwise returns
a map with at least one entry and a non-empty `baseUrl`.

---

### `loadComposerConfig`

```pascal
PROCEDURE loadComposerConfig(repoRoot)
  INPUT: repoRoot: string
  OUTPUT: ComposerConfig | null

  TRY
    raw ← readFile(join(repoRoot, "composer.json"), "utf-8")
    composer ← JSON.parse(raw)
    psr4Raw ← composer.autoload?.["psr-4"] OR {}
    psr4Dev ← composer["autoload-dev"]?.["psr-4"] OR {}
    merged ← { ...psr4Raw, ...psr4Dev }

    psr4 ← new Map()
    FOR each [ns, dir] IN entries(merged) DO
      nsNorm ← ns.trimEnd("\\")
      dirNorm ← dir.replace("\\", "/").trimEnd("/")
      psr4.set(nsNorm, dirNorm)
    END FOR

    RETURN { psr4 }
  CATCH
    RETURN null
  END TRY
END PROCEDURE
```

**Preconditions:** `repoRoot` is readable.
**Postconditions:** Returns `null` if `composer.json` is absent or unparseable. Otherwise
returns a map (may be empty if no PSR-4 entries exist).

---

### `loadGoModulePath`

```pascal
PROCEDURE loadGoModulePath(repoRoot)
  INPUT: repoRoot: string
  OUTPUT: GoModuleConfig | null

  TRY
    content ← readFile(join(repoRoot, "go.mod"), "utf-8")
    match ← content.match(/^module\s+(\S+)/m)
    IF match THEN RETURN { modulePath: match[1] }
  CATCH
    // no go.mod
  END TRY
  RETURN null
END PROCEDURE
```

**Preconditions:** `repoRoot` is readable.
**Postconditions:** Returns `null` if `go.mod` is absent or has no `module` directive.

---

### `loadCSharpProjectConfig`

```pascal
PROCEDURE loadCSharpProjectConfig(repoRoot)
  INPUT: repoRoot: string
  OUTPUT: CSharpProjectConfig[]

  configs ← []
  queue ← [{ dir: repoRoot, depth: 0 }]
  dirsScanned ← 0
  MAX_DEPTH ← 5
  MAX_DIRS ← 100
  SKIP_DIRS ← { "node_modules", ".git", "bin", "obj" }

  WHILE queue IS NOT empty AND dirsScanned < MAX_DIRS DO
    { dir, depth } ← queue.shift()
    dirsScanned ← dirsScanned + 1

    TRY
      entries ← readdir(dir, { withFileTypes: true })

      FOR each entry IN entries DO
        IF entry.isDirectory() AND depth < MAX_DEPTH THEN
          IF entry.name NOT IN SKIP_DIRS THEN
            queue.push({ dir: join(dir, entry.name), depth: depth + 1 })
          END IF
        END IF

        IF entry.isFile() AND entry.name ends with ".csproj" THEN
          TRY
            content ← readFile(join(dir, entry.name), "utf-8")
            nsMatch ← content.match(/<RootNamespace>\s*([^<]+)\s*<\/RootNamespace>/)
            rootNamespace ← IF nsMatch THEN nsMatch[1].trim()
                            ELSE entry.name.replace(".csproj", "")
            projectDir ← relative(repoRoot, dir).replace("\\", "/")
            configs.push({ rootNamespace, projectDir })
          CATCH
            CONTINUE  // unreadable .csproj
          END TRY
        END IF
      END FOR
    CATCH
      CONTINUE  // unreadable directory
    END TRY
  END WHILE

  RETURN configs
END PROCEDURE
```

**Preconditions:** `repoRoot` is readable.
**Postconditions:** Returns `[]` if no `.csproj` files found. BFS is bounded by
`MAX_DIRS = 100` and `MAX_DEPTH = 5`. `projectDir` uses forward slashes.

**Loop invariant:** `dirsScanned <= MAX_DIRS` at the start of every iteration.

---

### `loadSwiftPackageConfig`

```pascal
PROCEDURE loadSwiftPackageConfig(repoRoot)
  INPUT: repoRoot: string
  OUTPUT: SwiftPackageConfig | null

  targets ← new Map()
  SOURCE_DIRS ← ["Sources", "Package/Sources", "src"]

  FOR each sourceDir IN SOURCE_DIRS DO
    TRY
      fullPath ← join(repoRoot, sourceDir)
      entries ← readdir(fullPath, { withFileTypes: true })
      FOR each entry IN entries DO
        IF entry.isDirectory() THEN
          targets.set(entry.name, sourceDir + "/" + entry.name)
        END IF
      END FOR
    CATCH
      CONTINUE  // directory absent
    END TRY
  END FOR

  IF targets.size > 0 THEN RETURN { targets }
  RETURN null
END PROCEDURE
```

**Preconditions:** `repoRoot` is readable.
**Postconditions:** Returns `null` if none of the source dirs exist or contain
subdirectories. Otherwise returns a map with at least one entry.

---

### `loadLanguageConfigs` — parallel orchestrator

```pascal
PROCEDURE loadLanguageConfigs(repoRoot)
  INPUT: repoRoot: string
  OUTPUT: LanguageConfigs

  [tsconfig, composer, goModule, csharp, swift] ← await Promise.all([
    loadTsconfigPaths(repoRoot),
    loadComposerConfig(repoRoot),
    loadGoModulePath(repoRoot),
    loadCSharpProjectConfig(repoRoot),
    loadSwiftPackageConfig(repoRoot),
  ])

  RETURN { tsconfig, composer, goModule, csharp, swift }
END PROCEDURE
```

**Postconditions:** Always returns a `LanguageConfigs` object. Fields are `null` / `[]`
when the corresponding config file is absent. Never throws.
