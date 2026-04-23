---
inclusion: fileMatch
fileMatchPattern: "src/parser/**"
---

# Legacy Parser Reference

The `legacy-parser/` folder is read-only. Use it as a reference — port logic into `src/`, never edit it.

## What to use and where to port it

### 1. Tree-sitter queries → `src/parser/queries.ts`

**Source**: `legacy-parser/parser/ingestion/tree-sitter-queries.ts`

The most valuable file. Battle-tested S-expression queries for all 13 languages (TS, JS, Python, Java, C, C++, C#, Go, Rust, PHP, Ruby, Kotlin, Swift). Each query set captures:
- `@definition.*` — functions, classes, methods, interfaces, structs, enums, traits, namespaces, macros, typedefs, unions, properties, records, delegates, annotations, constructors, templates
- `@import` / `@import.source` — import/use/require statements
- `@call` / `@call.name` — function and method calls, constructor calls
- `@heritage.*` — extends, implements, trait-impl

Our current `src/parser/index.ts` uses a naive `isSymbolNode()` check against 5 node types. Replacing it with these queries gives correct extraction across all 12 languages immediately.

Port the `LANGUAGE_QUERIES` record and all per-language query strings verbatim.

---

### 2. Symbol table → `src/indexer/symbol-table.ts`

**Source**: `legacy-parser/parser/ingestion/symbol-table.ts`

Two-index design:
- `fileIndex`: `Map<filePath, Map<name, SymbolDefinition>>` — O(1) exact lookup per file
- `globalIndex`: `Map<name, SymbolDefinition[]>` — fuzzy/global lookup across all files

Exposes: `add`, `lookupExact`, `lookupExactFull`, `lookupFuzzy`, `getStats`, `clear`.

Required for Phase 3 (reference resolution). Our current code has no symbol table.

Adjust `SymbolDefinition` to reference our `Symbol` type from `src/types/index.ts`.

---

### 3. Resolution context → `src/indexer/phase3-resolution.ts`

**Source**: `legacy-parser/parser/ingestion/resolution-context.ts`

Three-tier resolution strategy:
1. Same-file (`lookupExactFull`) — confidence 0.95
2. Import-scoped (`lookupFuzzy` filtered by `importMap`) — confidence 0.90
3. Global fallback (all candidates) — confidence 0.50

Key constants to port:
```typescript
export const TIER_CONFIDENCE = {
  'same-file': 0.95,
  'import-scoped': 0.9,
  'global': 0.5,
};
```

The `resolve(name, fromFile)` function and `TieredCandidates` type are directly applicable. The per-file cache (`enableCache` / `clearCache`) is a useful optimization for large repos.

---

### 4. AST cache → `src/parser/ast-cache.ts`

**Source**: `legacy-parser/parser/ingestion/ast-cache.ts`

LRU cache for parsed AST trees. Prevents re-parsing the same file across phases (parsing → import resolution → call resolution).

Interface: `get(filePath)`, `set(filePath, tree)`, `clear()`, `stats()`.

Port as-is. Cap size at `maxChunkFiles` or a fixed constant (e.g. 50).

---

### 5. Buffer size constants → `src/utils/limits.ts`

**Source**: `legacy-parser/parser/ingestion/constants.ts`

```typescript
// Adaptive buffer: 2× file size, clamped between 512KB and 32MB
export const getTreeSitterBufferSize = (contentLength: number): number =>
  Math.min(Math.max(contentLength * 2, 512 * 1024), 32 * 1024 * 1024);

export const TREE_SITTER_MAX_BUFFER = 32 * 1024 * 1024; // skip files larger than this
```

Our current parser has no buffer sizing — it will silently fail on files over ~200KB. Merge these into the existing `src/utils/limits.ts`.

---

### 6. File ignore rules → `src/utils/ignore.ts`

**Source**: `legacy-parser/parser/ignore-service.ts`

Comprehensive ignore lists:
- `DEFAULT_IGNORE_LIST` — VCS dirs, IDEs, `node_modules`, `vendor`, build outputs (`dist`, `build`, `target`, `.next`, etc.), test/coverage dirs, temp/cache dirs
- `IGNORED_EXTENSIONS` — images, archives, binaries, media, fonts, `.wasm`, `.map`, `.d.ts`, certificates, data files
- `IGNORED_FILES` — lock files, `.gitignore`, `.env.*`, `LICENSE`, `CHANGELOG`, etc.

`shouldIgnorePath(filePath)` handles compound extensions (`.min.js`, `.bundle.js`) and hidden files.

Our current walker only skips `node_modules`, `.git`, and `dist`. Port `shouldIgnorePath` to `src/utils/ignore.ts` and call it from `walkFileTree`.

---

### 7. Filesystem walker → `src/indexer/phase1.ts`

**Source**: `legacy-parser/parser/ingestion/filesystem-walker.ts`

Two-phase scan pattern:
1. `walkRepositoryPaths` — stat files only (path + size), no content in memory. ~10MB for 100K files vs ~1GB+ with content.
2. `readFileContents(repoPath, relativePaths)` — on-demand reads for a specific set of paths, returns `Map<path, content>`.

Key detail: skip files larger than `MAX_FILE_SIZE` (512KB) during stat phase — they're usually generated/vendored and crash tree-sitter.

Refactor our current `walkFileTree` to use this two-phase pattern. Add a `ScannedFile` type (`{ path: string; size: number }`).

---

### 8. Framework detection → `src/parser/framework-detection.ts`

**Source**: `legacy-parser/parser/ingestion/framework-detection.ts`

Two detection strategies:

**Path-based** (`detectFrameworkFromPath`): returns `FrameworkHint { framework, entryPointMultiplier, reason }` for 15+ frameworks based on file path patterns. Examples:
- `/controllers/` + `.php` → Laravel controller, multiplier 3.0
- `/pages/api/` → Next.js API route, multiplier 3.0
- `views.py` → Django views, multiplier 3.0
- `/routes/` + `.go` → Go HTTP routes, multiplier 2.5

**AST-based** (`detectFrameworkFromAST`): matches decorator/annotation text against `FRAMEWORK_AST_PATTERNS`. Examples:
- `@Controller`, `@Get`, `@Post` → NestJS, multiplier 3.2
- `@RestController`, `@GetMapping` → Spring, multiplier 3.2
- `[ApiController]`, `[HttpGet]` → ASP.NET, multiplier 3.2
- `Route::get`, `Route::post` → Laravel, multiplier 3.0

Use `detectFrameworkFromAST` during Phase 2 symbol extraction (called on the first 300 chars of each definition node). Use `detectFrameworkFromPath` during Phase 5 entry point scoring.

The `FRAMEWORK_AST_PATTERNS` object is also directly usable as the pattern source for our framework-specific parsers (task 23).

---

### 9. Entry point scoring → `src/indexer/phase5-entry-points.ts`

**Source**: `legacy-parser/parser/ingestion/entry-point-scoring.ts`

Scoring formula:
```
finalScore = (calleeCount / (callerCount + 1)) × exportMultiplier × nameMultiplier × frameworkMultiplier
```

Where:
- `exportMultiplier`: 2.0 if exported/public, 1.0 otherwise
- `nameMultiplier`: 1.5 for entry-point name patterns, 0.3 for utility patterns, 1.0 otherwise
- `frameworkMultiplier`: from `detectFrameworkFromPath` or `detectFrameworkFromAST`

Port `ENTRY_POINT_PATTERNS` (per-language regex arrays for all 12 languages), `UTILITY_PATTERNS` (penalty list), `calculateEntryPointScore`, `isTestFile`, and `isUtilityFile`.

Skip nodes with `calleeCount === 0` — they can't be entry points for a flow.

---

### 10. Language config loaders → `src/indexer/language-config.ts`

**Source**: `legacy-parser/parser/ingestion/language-config.ts`

Config loaders needed for accurate import resolution in Phase 3:
- `loadTsconfigPaths(repoRoot)` — parses `tsconfig.json` path aliases (e.g. `@/` → `src/`). Tries `tsconfig.json`, `tsconfig.app.json`, `tsconfig.base.json`.
- `loadComposerConfig(repoRoot)` — parses `composer.json` PSR-4 autoload mappings for PHP/Laravel/Magento 2.
- `loadGoModulePath(repoRoot)` — parses `go.mod` module path.
- `loadCSharpProjectConfig(repoRoot)` — scans for `.csproj` files, extracts `<RootNamespace>`.
- `loadSwiftPackageConfig(repoRoot)` — scans `Sources/` and `Package/Sources/` for SPM targets.

Port all five loaders. Call them once at the start of Phase 3, reuse across all files.

---

### 11. Community detection reference → `src/indexer/phase4-clustering.ts`

**Source**: `legacy-parser/parser/ingestion/community-processor.ts`

The legacy uses Leiden (a Louvain variant). We use Louvain as specified in our design, but these patterns apply directly:

- Build undirected graph from `CALLS`, `EXTENDS`, `IMPLEMENTS` edges only (not `IMPORTS` or `DEFINES`)
- Filter degree-1 nodes for large graphs (>10K symbols) — they become singletons and waste iteration time
- Skip singleton communities (< 2 members) — matches our `Cluster.symbols.length >= 2` invariant
- `calculateCohesion()` — internal edge density: `internalEdges / totalEdges`, sample up to 50 members for large communities
- `generateHeuristicLabel()` — use most common parent folder name among member file paths as the cluster name; fall back to common name prefix; last resort `Cluster_N`
- Confidence score = modularity contribution of the community (from algorithm output)

---

### What NOT to port

| File | Reason |
|---|---|
| `delta-processor.ts` | Tightly coupled to legacy database service + TypeORM entities from a different architecture |
| `pipeline.ts` | Our pipeline structure differs; use as conceptual reference only |
| `workers/worker-pool.ts` | Overkill for MVP; use sequential fallback, add workers later |
| `resolvers/` | Complex language-specific import resolvers; port incrementally per language in Phase 3 |
| `call-processor.ts` | Reference for Phase 3 call resolution logic, but port selectively |
| `heritage-processor.ts` | Reference for Phase 3 inheritance resolution, but port selectively |
