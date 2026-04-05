# Requirements: Language Config Loaders

## Requirement 1: TypeScript path alias loading

**User story**: As Phase 3 import resolution, I need TypeScript path aliases so that
imports like `@/services/auth` resolve to `src/services/auth.ts` instead of
`unresolved:@/services/auth`.

### Acceptance Criteria

1.1 `loadTsconfigPaths(repoRoot)` reads `tsconfig.json`, `tsconfig.app.json`, and
`tsconfig.base.json` in that order, returning the first file that contains a non-empty
`compilerOptions.paths`.

1.2 JSON comments (`//` single-line and `/* */` multi-line) are stripped before parsing,
because tsconfig files allow comments that `JSON.parse` rejects.

1.3 Glob patterns are normalised: alias keys ending with `/*` have the `*` removed;
target values ending with `/*` have the `*` removed.

1.4 `baseUrl` defaults to `"."` when `compilerOptions.baseUrl` is absent.

1.5 Returns `null` when no candidate file exists or none contains `paths`.

1.6 Never throws — all I/O errors are caught and treated as "file not found".

---

## Requirement 2: PHP Composer PSR-4 loading

**User story**: As Phase 3 import resolution, I need PSR-4 namespace mappings so that
`App\Http\Controllers\UserController` resolves to `app/Http/Controllers/UserController.php`.

### Acceptance Criteria

2.1 `loadComposerConfig(repoRoot)` reads `composer.json` from the repo root.

2.2 Both `autoload["psr-4"]` and `autoload-dev["psr-4"]` sections are merged into a
single map (dev entries may override prod entries for the same namespace).

2.3 Namespace keys have trailing backslashes stripped (e.g. `"App\\"` → `"App"`).

2.4 Directory values have trailing slashes stripped and backslashes converted to forward
slashes.

2.5 Returns `null` when `composer.json` is absent or unparseable.

2.6 Never throws.

---

## Requirement 3: Go module path loading

**User story**: As Phase 3 import resolution, I need the Go module path so that
`github.com/acme/service/internal/auth` can be resolved relative to the repo root.

### Acceptance Criteria

3.1 `loadGoModulePath(repoRoot)` reads `go.mod` from the repo root.

3.2 Extracts the module path from the first line matching `module <path>`.

3.3 Returns `{ modulePath: string }` where `modulePath` is non-empty.

3.4 Returns `null` when `go.mod` is absent or contains no `module` directive.

3.5 Never throws.

---

## Requirement 4: C# project config loading

**User story**: As Phase 3 import resolution, I need C# root namespaces so that
`using Acme.Api.Controllers` resolves to the correct project directory.

### Acceptance Criteria

4.1 `loadCSharpProjectConfig(repoRoot)` performs a BFS scan for `.csproj` files starting
at `repoRoot`.

4.2 BFS is bounded: maximum depth of 5 levels and maximum 100 directories scanned.

4.3 Directories named `node_modules`, `.git`, `bin`, and `obj` are skipped during BFS.

4.4 For each `.csproj` found, `<RootNamespace>` is extracted from the XML content.

4.5 When `<RootNamespace>` is absent, the `.csproj` filename without extension is used as
the root namespace.

4.6 `projectDir` is the path of the `.csproj` directory relative to `repoRoot`, using
forward slashes.

4.7 Returns `[]` when no `.csproj` files are found.

4.8 Individual unreadable `.csproj` files are skipped; the scan continues.

4.9 Never throws.

---

## Requirement 5: Swift SPM target loading

**User story**: As Phase 3 import resolution, I need Swift SPM target directories so that
`import MyLib` resolves to `Sources/MyLib/`.

### Acceptance Criteria

5.1 `loadSwiftPackageConfig(repoRoot)` scans `Sources/`, `Package/Sources/`, and `src/`
for subdirectories.

5.2 Each subdirectory name becomes a target key; the value is `<sourceDir>/<name>`.

5.3 Returns `{ targets: Map }` with at least one entry when any source directory contains
subdirectories.

5.4 Returns `null` when none of the source directories exist or contain subdirectories.

5.5 Never throws.

---

## Requirement 6: Parallel orchestration

**User story**: As Phase 3, I need all language configs loaded in a single call before
resolution begins, with minimal latency.

### Acceptance Criteria

6.1 `loadLanguageConfigs(repoRoot)` runs all five loaders concurrently via `Promise.all`.

6.2 Returns a `LanguageConfigs` object with fields `tsconfig`, `composer`, `goModule`,
`csharp`, and `swift`.

6.3 `csharp` is always an array (never `null`).

6.4 The function never throws regardless of `repoRoot` value.

6.5 All five loaders complete before the function resolves.

---

## Requirement 7: TypeScript strict compliance

### Acceptance Criteria

7.1 No `any` — use `unknown` with type guards where needed.

7.2 All exported functions have explicit return type annotations.

7.3 Returned map types use `ReadonlyMap<K, V>` (or `Map<K, V>` with `readonly` interface
fields) to prevent mutation by callers.

7.4 The implementation compiles under `"strict": true` with no errors.

7.5 Source file stays under 250 lines; test file stays under 500 lines.
