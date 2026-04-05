# Parser Improvement Notes

Findings from comparing `legacy-parser/` against `src/parser/`.

---

## What's Already Good

Our parser has correctly ported the most critical pieces:

- `src/parser/queries.ts` — all 12 language query strings are present and match the legacy
- `src/parser/parse-file.ts` — adaptive buffer sizing and MAX_FILE_SIZE guard are in place
- `src/parser/extract-symbols.ts` — query-based extraction with `@definition.*`, `@import`, `@call`, `@heritage.*` captures
- `src/parser/init.ts` — grammar loader for all 12 languages

---

## Gaps and Improvements

### 1. Missing: Kotlin Language Support

**Legacy has it, we don't.**

`legacy-parser` supports 13 languages — we support 12. Kotlin is missing from our `Language` type, `LANGUAGE_QUERIES`, and `initParser`. The legacy `KOTLIN_QUERIES` covers:

- `class_declaration` (class, interface, object, companion)
- `function_declaration`, `property_declaration`, `enum_entry`, `type_alias`
- `import_header`, `call_expression`, `navigation_expression`, `constructor_invocation`
- `infix_expression` (e.g. `a to b`)
- Heritage via `delegation_specifier` (both bare `user_type` and `constructor_invocation`)

**Action**: Add `"kotlin"` to `Language`, port `KOTLIN_QUERIES` to `src/parser/queries.ts`, add grammar loader in `src/parser/init.ts`.

---

### 2. Missing: AST Cache (`src/parser/ast-cache.ts`)

**Legacy has it, we don't.**

The legacy `createASTCache(maxSize)` is an LRU cache keyed by file path. Without it, every phase that needs the AST (parsing → import resolution → call resolution) re-parses the same file from disk.

Key design:
- `Map<string, Tree>` with manual LRU eviction (delete-and-reinsert on get)
- `delete()` called on evicted trees to free native memory
- `stats()` for observability

**Action**: Create `src/parser/ast-cache.ts`. Port `createASTCache` verbatim, replacing `any` with `Parser.Tree`.

```typescript
import Parser from "tree-sitter";

export interface ASTCache {
  get(filePath: string): Parser.Tree | undefined;
  set(filePath: string, tree: Parser.Tree): void;
  clear(): void;
  stats(): { size: number; maxSize: number };
}

export function createASTCache(maxSize = 50): ASTCache { ... }
```

---

### 3. Missing: Symbol Table (`src/indexer/resolution/symbol-table.ts`)

**Legacy has it, we don't.**

Our Phase 3 has no symbol table. The legacy uses a two-index design:

- `fileIndex: Map<filePath, Map<name, SymbolDefinition>>` — O(1) exact lookup per file (confidence 0.95)
- `globalIndex: Map<name, SymbolDefinition[]>` — fuzzy/global lookup across all files (confidence 0.50)

Both indexes share the same object reference — zero extra memory.

The `SymbolDefinition` type carries `nodeId`, `filePath`, `type`, `parameterCount`, `returnType`, and `ownerId` (links methods to their owning class).

**Action**: Create `src/indexer/resolution/symbol-table.ts`. Adjust `SymbolDefinition.nodeId` to reference our `Symbol.id` from `src/types/index.ts`.

---

### 4. Missing: Resolution Context with Tiered Confidence (`src/indexer/resolution/resolution-context.ts`)

**Legacy has it, we don't.**

The legacy `createResolutionContext()` implements a 4-tier resolution strategy with explicit confidence scores:

| Tier | Strategy | Confidence |
|------|----------|------------|
| 1 | Same-file (`lookupExactFull`) | 0.95 |
| 2a-named | Named binding chain (aliased imports) | 0.90 |
| 2a | Import-scoped (`lookupFuzzy` filtered by `importMap`) | 0.90 |
| 2b | Package-scoped (filtered by `packageMap`) | 0.90 |
| 3 | Global fallback (all candidates) | 0.50 |

It also has a per-file cache (`enableCache` / `clearCache`) that avoids re-resolving the same name within a single file's processing pass — important for large repos.

**Action**: Create `src/indexer/resolution/resolution-context.ts`. Port `TIER_CONFIDENCE`, `TieredCandidates`, `ResolutionTier`, and `createResolutionContext`. Wire into Phase 3.

---

### 5. Missing: Language Config Loaders (`src/indexer/language-config.ts`)

**Legacy has it, we don't.**

Without these, import resolution in Phase 3 will fail for path aliases, PSR-4 namespaces, and Go module paths. The legacy provides five loaders:

| Loader | Source file | Resolves |
|--------|-------------|---------|
| `loadTsconfigPaths` | `tsconfig.json` | `@/` → `src/` aliases |
| `loadComposerConfig` | `composer.json` | PSR-4 namespace → dir |
| `loadGoModulePath` | `go.mod` | module path prefix |
| `loadCSharpProjectConfig` | `*.csproj` | `<RootNamespace>` |
| `loadSwiftPackageConfig` | `Sources/` scan | SPM target → dir |

Notable details:
- `loadTsconfigPaths` strips JSON comments before parsing (tsconfig allows `//` comments)
- `loadComposerConfig` merges `autoload` and `autoload-dev`
- `loadCSharpProjectConfig` does a BFS scan capped at 5 levels / 100 dirs

**Action**: Create `src/indexer/language-config.ts`. Port all five loaders. Call them once at the start of Phase 3 and pass results into the resolution context.

---

### 6. Missing: Comprehensive File Ignore Rules (`src/utils/ignore.ts`)

**Legacy has it, we don't (partially).**

Our current walker only skips `node_modules`, `.git`, and `dist`. The legacy `shouldIgnorePath` covers:

- **`DEFAULT_IGNORE_LIST`** (60+ entries): VCS dirs, IDEs, all dependency dirs (`vendor`, `venv`, `__pycache__`), all build outputs (`.next`, `.nuxt`, `.turbo`, `target`), test/coverage dirs, temp/cache dirs
- **`IGNORED_EXTENSIONS`** (80+ entries): images, archives, binaries, media, fonts, `.wasm`, `.map`, `.d.ts`, certificates, data files
- **`IGNORED_FILES`** (30+ entries): lock files, `.env.*`, `LICENSE`, `CHANGELOG`, etc.
- **Compound extension handling**: `.min.js`, `.bundle.js`, `.chunk.js`
- **Generated file detection**: `.generated.`, `.d.ts`

Without this, Phase 1 will index lock files, images, `.d.ts` declaration files, and minified bundles — wasting parse time and polluting the graph.

**Action**: Expand `src/utils/ignore.ts` with the full `DEFAULT_IGNORE_LIST`, `IGNORED_EXTENSIONS`, and `IGNORED_FILES` sets. Port `shouldIgnorePath` including compound extension handling.

---

### 7. Missing: Two-Phase Filesystem Walker (`src/indexer/structure/`)

**Legacy has it, we don't.**

The legacy uses a two-phase scan to avoid loading all file contents into memory at once:

1. `walkRepositoryPaths` — stat files only (path + size). ~10MB for 100K files vs ~1GB+ with content.
2. `readFileContents(repoPath, relativePaths)` — on-demand reads for a specific subset, returns `Map<path, content>`.

Files larger than `MAX_FILE_SIZE` (512KB) are skipped during the stat phase — before any content is read.

Batching uses `READ_CONCURRENCY = 32` with `Promise.allSettled` so one bad file doesn't abort the batch.

**Action**: Refactor Phase 1 walker to use this two-phase pattern. Add `ScannedFile { path: string; size: number }` type. Move size filtering to the stat phase.

---

### 8. Missing: Framework Detection (`src/parser/framework-detection.ts`)

**Legacy has it, we don't.**

The legacy provides two detection strategies used during parsing and entry point scoring:

**Path-based** (`detectFrameworkFromPath`): 50+ patterns across 15 frameworks. Returns `FrameworkHint { framework, entryPointMultiplier, reason }`. Examples:
- `/routes/*.php` → Laravel, multiplier 3.0
- `/pages/api/` → Next.js API route, multiplier 3.0
- `views.py` → Django, multiplier 3.0
- `/controllers/*.java` → Spring, multiplier 3.0

**AST-based** (`detectFrameworkFromAST`): Matches decorator/annotation text against `FRAMEWORK_AST_PATTERNS`. Examples:
- `@Controller`, `@Get` → NestJS, multiplier 3.2
- `@RestController`, `@GetMapping` → Spring, multiplier 3.2
- `[ApiController]`, `[HttpGet]` → ASP.NET, multiplier 3.2

Without this, Phase 5 entry point scoring has no framework awareness — it will miss obvious entry points like NestJS controllers and Laravel route handlers.

**Action**: Create `src/parser/framework-detection.ts`. Port `detectFrameworkFromPath`, `detectFrameworkFromAST`, and `FRAMEWORK_AST_PATTERNS`. Call `detectFrameworkFromAST` during Phase 2 symbol extraction (on first 300 chars of each definition node). Call `detectFrameworkFromPath` during Phase 5 entry point scoring.

---

### 9. Missing: Entry Point Scoring (`src/indexer/processes/entry-point-scoring.ts`)

**Legacy has it, we don't.**

The legacy scoring formula:

```
finalScore = (calleeCount / (callerCount + 1)) × exportMultiplier × nameMultiplier × frameworkMultiplier
```

Where:
- `exportMultiplier`: 2.0 if exported/public, 1.0 otherwise
- `nameMultiplier`: 1.5 for entry-point name patterns, 0.3 for utility patterns, 1.0 otherwise
- `frameworkMultiplier`: from `detectFrameworkFromPath` or `detectFrameworkFromAST`

The legacy also provides:
- `ENTRY_POINT_PATTERNS` — per-language regex arrays for all 12 languages (main, handle*, on*, Controller, etc.)
- `UTILITY_PATTERNS` — penalty list (get*, set*, is*, format*, parse*, Helper, Util)
- `isTestFile(filePath)` — 20+ patterns across all languages
- `isUtilityFile(filePath)` — utility/helper folder detection

Nodes with `calleeCount === 0` are skipped — they can't be entry points for a flow.

**Action**: Create `src/indexer/processes/entry-point-scoring.ts`. Port `calculateEntryPointScore`, `ENTRY_POINT_PATTERNS`, `UTILITY_PATTERNS`, `isTestFile`, and `isUtilityFile`.

---

### 10. Code Quality Issues in Current Parser

#### `ast-cache.ts` uses `any`

The legacy `ASTCache` interface uses `any` for tree values. When we port it, replace with `Parser.Tree` to satisfy our no-`any` rule.

#### `inferVisibility` reads `node.parent?.text`

In `extract-symbols.ts`, `inferVisibility` scans the full parent node text with `includes("private ")`. This is fragile — a string literal `"private "` inside a method body would trigger a false positive. The legacy avoids this by checking modifier nodes directly.

**Action**: Refactor `inferVisibility` to walk `node.children` for modifier keyword nodes rather than scanning raw text.

#### `inferModifiers` scans full node text

Same issue as above — `text.includes("static ")` will match string literals. Walk modifier child nodes instead.

#### Symbol ID uses `filePath:name:line` — not globally unique

In `extractSymbolsWithQueries`, symbol IDs are constructed as:

```typescript
id: `${filePath}:${name}:${defNode.startPosition.row}`
```

Two overloaded methods with the same name on the same line (edge case) would collide. The legacy uses a proper UUID or hash. Consider using `crypto.randomUUID()` (already imported in the fallback path) or a stable hash of `filePath + name + startLine + startColumn`.

---

## Priority Order

| Priority | Item | Impact |
|----------|------|--------|
| 1 | Comprehensive ignore rules (#6) | Prevents junk in graph |
| 2 | Two-phase filesystem walker (#7) | Memory safety at scale |
| 3 | Symbol table (#3) | Required for Phase 3 |
| 4 | Resolution context (#4) | Required for Phase 3 |
| 5 | Language config loaders (#5) | Required for accurate import resolution |
| 6 | AST cache (#2) | Performance — avoids re-parsing |
| 7 | Framework detection (#8) | Required for Phase 5 accuracy |
| 8 | Entry point scoring (#9) | Required for Phase 5 |
| 9 | Kotlin support (#1) | Language coverage |
| 10 | Code quality fixes (#10) | Correctness and type safety |
