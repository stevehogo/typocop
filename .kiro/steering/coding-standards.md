---
inclusion: fileMatch
fileMatchPattern: "src/**"
---

# Coding Standards

## Language & Runtime

- TypeScript strict mode (`"strict": true` in tsconfig)
- Node.js — no browser APIs
- ESM modules (`"type": "module"` in package.json)
- All async operations use `async/await`, never raw Promise chains

## TypeScript Rules

- No `any` — use `unknown` and narrow with type guards
- Prefer discriminated unions over optional fields for variant types
- All public functions must have explicit return type annotations
- Use `readonly` on data model interfaces where mutation is not intended
- Prefer `type` aliases for unions/primitives, `interface` for object shapes

```typescript
// Good
interface Symbol {
  readonly id: string;
  readonly name: string;
  readonly kind: SymbolKind;
}

type SymbolKind = "function" | "class" | "method" | "interface" | "variable" | "import" | "export" | "type";

// Bad
const process = (x: any) => { ... }
```

## File & Module Structure

```
src/
  cli/          # CLI entry point, command parsing, executor
  parser/       # Tree-sitter AST parsing (ast-node, init, parse-file, queries, extract-symbols, language)
  indexer/      # 6-phase indexing pipeline
    structure/  # Phase 1: walk file tree, map folder/file relationships
    parsing/    # Phase 2: extract symbols from ASTs
    resolution/ # Phase 3: resolve imports, calls, inheritance
    clustering/ # Phase 4: group symbols into functional communities
    processes/  # Phase 5: trace execution flows from entry points
    search/     # Phase 6: build hybrid vector + keyword indexes
    index.ts    # re-exports all phases
  graph/        # Neo4j graph database interface
  vector/       # pgvector semantic search interface
  enrichment/   # AI Context Enrichment component
  query/        # Query server, intent classification, query execution
  mcp/          # MCP server and tool registration
  types/        # Shared data model types + arbitraries (no logic)
  utils/        # Pure utility functions (ignore, limits)
```

## Folder Grouping Rule

**Group files by domain, not by type.** When a folder grows beyond ~5 files, split it into subfolders named after the domain concern — not after the file type (no `helpers/`, `utils/`, `models/` inside a domain folder).

### When to create a subfolder

Create a subfolder when a folder has more than 5 files that share a distinct responsibility:

```
// Too flat — hard to navigate
src/parser/
  ast-node.ts
  extract-symbols.ts
  extract-queries.ts
  init-typescript.ts
  init-python.ts
  init-java.ts
  language-detect.ts
  parse-file.ts
  queries-typescript.ts
  queries-python.ts

// Grouped by domain concern
src/parser/
  ast/            # AST node types and traversal
  grammars/       # Per-language grammar initialisation
  queries/        # Per-language tree-sitter query strings
  extract/        # Symbol extraction from ASTs
  index.ts
```

### Subfolder rules

- Name subfolders after the **domain concern**, not the file type
- Each subfolder has an `index.ts` as its public API
- Co-locate `index.test.ts` with `index.ts` in the same subfolder
- Additional files in the subfolder are implementation details — not re-exported from the parent
- No re-export shim files — consumers import from the subfolder's `index.ts` directly

### What NOT to do

```
// Bad — grouped by file type, not domain
src/parser/
  types/        ← types belong in src/types/
  helpers/      ← vague, not a domain
  utils/        ← vague, not a domain
  models/       ← duplicates src/types/

// Bad — re-export shim
src/parser/index.ts  ← just re-exports everything from subfiles, adds no value
```

### Canonical locations

- All shared data model types → `src/types/index.ts` — never redefine inline
- All resource limit constants → `src/utils/limits.ts`
- No `models/` folder — it duplicates `types/`
- No `__tests__/` folder — tests are co-located with their source file
- No circular imports between modules

## Stub Code Rule

Whenever you generate stub or placeholder code that is not yet implemented, you **must** include a `TODO` comment that references the task or requirement it belongs to. This ensures that after all spec tasks are executed, a simple search for `TODO` reveals any unfinished work.

```typescript
// Good — stub with a traceable TODO
export function resolveImports(symbols: Symbol[]): ResolvedSymbol[] {
  // TODO: Task 3.2 — resolve cross-file import references
  return [];
}

// Bad — silent stub with no indication it's incomplete
export function resolveImports(symbols: Symbol[]): ResolvedSymbol[] {
  return [];
}
```

### Rules

- Every stub function/method body must have a `// TODO: <task reference> — <short description>` comment
- The task reference should match the task ID in `tasks.md` (e.g., `Task 4`, `Task 2.3`)
- Never return empty arrays, `null`, `undefined`, or `{}` from a stub without a TODO comment
- After all tasks are complete, run `grep -r "TODO:" src/` to verify no stubs remain

## Naming Conventions

- Files: `kebab-case.ts`
- Classes/Interfaces/Types: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE`
- Enum values: `camelCase` (matching the string literal union pattern used in design)

## Error Handling

- All I/O operations (file reads, DB calls, API calls) must handle errors explicitly
- Use typed error results or throw typed Error subclasses — never swallow errors silently
- Database connection failures: retry with exponential backoff, max 3 attempts (Req 19)
- Unparseable files: log warning with file path + error, skip and continue (Req 18)
- Pipeline phase failures: log error and halt pipeline (Req 3.7)

```typescript
// Retry pattern for DB connections
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await sleep(Math.pow(2, attempt) * 100); // exponential backoff
    }
  }
  throw new Error("unreachable");
}
```

## Security Rules

- Never send full source code to external APIs — only symbol signatures (Req 22.2)
- Sanitize all natural language query inputs before graph DB execution (Req 22.3)
- Validate all file paths for directory traversal patterns before processing (Req 22.4)
- MCP server connections require token-based authentication (Req 22.5)

## Performance Targets (must be respected in implementation)

- Simple queries: < 500ms
- Complex graph traversals: < 2s
- Indexing throughput: ≥ 10,000 LOC/s
- Semantic search: < 100ms
- Symbol lookup by ID: < 100ms

## Resource Limits (must be enforced)

- Maximum file size during indexing (Req 23.1)
- Maximum graph size (Req 23.2)
- Query timeout (Req 23.3)
- Maximum graph traversal depth (Req 23.4)

Define these as named constants in `src/utils/limits.ts`.
