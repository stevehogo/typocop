# Correctness Properties — Language Config Loaders

Part of the [Language Config Loaders Design](./design.md).

## Use Cases

### UC-1: TypeScript monorepo with path aliases

A NestJS project has `tsconfig.json` with `"@/*": ["src/*"]`. Phase 3 calls
`loadLanguageConfigs(repoRoot)`. The returned `tsconfig.aliases` map contains
`"@/" → "src/"`. The resolution context uses this to resolve `import { Foo } from "@/foo"`
to `src/foo.ts`.

### UC-2: Laravel project with PSR-4 autoloading

A Laravel project has `composer.json` with `"App\\" → "app/"` in `autoload["psr-4"]` and
`"Tests\\" → "tests/"` in `autoload-dev["psr-4"]`. Both entries appear in the returned
`psr4` map with trailing backslashes stripped.

### UC-3: Go module import resolution

A Go project has `go.mod` starting with `module github.com/acme/service`. The loader
returns `{ modulePath: "github.com/acme/service" }`. Phase 3 uses this to strip the module
prefix when resolving intra-package imports.

### UC-4: C# solution with multiple projects

A .NET solution has `Api/Api.csproj` (with `<RootNamespace>Acme.Api</RootNamespace>`) and
`Core/Core.csproj` (no `<RootNamespace>`). The loader returns two configs:
`{ rootNamespace: "Acme.Api", projectDir: "Api" }` and
`{ rootNamespace: "Core", projectDir: "Core" }`.

### UC-5: Swift SPM package

A Swift package has `Sources/MyLib/` and `Sources/MyApp/`. The loader returns
`{ targets: Map { "MyLib" → "Sources/MyLib", "MyApp" → "Sources/MyApp" } }`.

### UC-6: Non-matching project (Python repo)

A Python repo has none of the config files. `loadLanguageConfigs` returns
`{ tsconfig: null, composer: null, goModule: null, csharp: [], swift: null }` without
throwing.

---

## Correctness Properties

### Property 1: Alias keys never end with `*`

For any `TsconfigPaths` returned by `loadTsconfigPaths`, every key in `aliases` must not
end with `*`.

```typescript
// fast-check property
fc.assert(fc.asyncProperty(
  fc.record({
    paths: fc.dictionary(
      fc.string({ minLength: 1 }).map(s => s + "/*"),
      fc.array(fc.string({ minLength: 1 }).map(s => s + "/*"), { minLength: 1 })
    )
  }),
  async (compilerOptions) => {
    const result = await loadTsconfigPathsFromParsed(compilerOptions);
    if (!result) return true;
    for (const key of result.aliases.keys()) {
      if (key.endsWith("*")) return false;
    }
    return true;
  }
));
```

### Property 2: Alias values never end with `*`

Same as Property 1 but for values in the `aliases` map.

### Property 3: PSR-4 namespace keys never end with `\`

For any `ComposerConfig` returned by `loadComposerConfig`, every key in `psr4` must not
end with `\`.

```typescript
fc.assert(fc.asyncProperty(
  fc.dictionary(
    fc.string({ minLength: 1 }).map(s => s + "\\"),
    fc.string({ minLength: 1 })
  ),
  async (psr4Raw) => {
    const result = buildComposerConfig(psr4Raw, {});
    for (const key of result.psr4.keys()) {
      if (key.endsWith("\\")) return false;
    }
    return true;
  }
));
```

### Property 4: PSR-4 directory values never end with `/`

For any `ComposerConfig`, every value in `psr4` must not end with `/`.

### Property 5: Go module path is non-empty when loader returns non-null

For any `GoModuleConfig` returned by `loadGoModulePath`, `modulePath` is a non-empty
string.

```typescript
fc.assert(fc.asyncProperty(
  fc.string({ minLength: 1 }).filter(s => /^\S+$/.test(s)),
  async (modulePath) => {
    const goModContent = `module ${modulePath}\n\ngo 1.21\n`;
    const result = await loadGoModulePathFromContent(goModContent);
    return result !== null && result.modulePath === modulePath;
  }
));
```

### Property 6: C# projectDir uses forward slashes only

For any `CSharpProjectConfig` in the array returned by `loadCSharpProjectConfig`,
`projectDir` must not contain `\`.

```typescript
fc.assert(fc.asyncProperty(
  fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 5 }),
  async (projectNames) => {
    // construct temp dirs with .csproj files
    const results = await loadCSharpProjectConfigFromDirs(projectNames);
    return results.every(c => !c.projectDir.includes("\\"));
  }
));
```

### Property 7: `loadLanguageConfigs` never throws

For any string passed as `repoRoot` (including non-existent paths), `loadLanguageConfigs`
must resolve (not reject).

```typescript
fc.assert(fc.asyncProperty(
  fc.string(),
  async (repoRoot) => {
    try {
      await loadLanguageConfigs(repoRoot);
      return true;
    } catch {
      return false;
    }
  }
));
```

### Property 8: `loadLanguageConfigs` result shape is always complete

The returned object always has all five keys: `tsconfig`, `composer`, `goModule`,
`csharp`, `swift`. `csharp` is always an array (never null).

```typescript
fc.assert(fc.asyncProperty(
  fc.string(),
  async (repoRoot) => {
    const result = await loadLanguageConfigs(repoRoot);
    return (
      "tsconfig" in result &&
      "composer" in result &&
      "goModule" in result &&
      Array.isArray(result.csharp) &&
      "swift" in result
    );
  }
));
```

---

## Testing Strategy

### Unit tests (`src/indexer/language-config.test.ts`)

Use `vitest` with a temporary directory fixture (via `node:fs/promises` + `node:os`
`tmpdir`) to write real config files and assert loader output.

Key example tests:
- `loadTsconfigPaths` with `//` and `/* */` comments in tsconfig
- `loadTsconfigPaths` falls back to `tsconfig.app.json` when `tsconfig.json` has no paths
- `loadComposerConfig` merges `autoload` and `autoload-dev`
- `loadCSharpProjectConfig` BFS stops at depth 5 and 100 dirs
- `loadCSharpProjectConfig` falls back to filename when `<RootNamespace>` absent
- `loadSwiftPackageConfig` finds targets in all three source dirs
- All loaders return `null`/`[]` when files are absent

### Property-based tests (`src/indexer/language-config.test.ts`)

Use `fast-check` for Properties 1–8 above. For filesystem-dependent properties, use
in-memory helper functions that exercise the parsing/normalisation logic directly (no
actual disk I/O needed for normalisation properties).

**Property test library**: `fast-check`

### Integration

`loadLanguageConfigs` is called from `resolveReferences` in Phase 3. The existing Phase 3
integration tests in `src/indexer/resolution/index.test.ts` cover the end-to-end path
once the loaders are wired in.
