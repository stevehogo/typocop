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
  cli/          # CLI entry point and command parsing
  parser/       # Tree-sitter AST parsing
  indexer/      # 6-phase indexing pipeline (phases 1-6)
  graph/        # Neo4j graph database interface
  vector/       # pgvector semantic search interface
  enrichment/   # AI Context Enrichment component
  query/        # Query server, intent classification, query execution
  mcp/          # MCP server and tool registration
  types/        # Shared data model types (no logic)
  utils/        # Pure utility functions
```

- One component per file, named after the component
- Types live in `src/types/` — never co-located with logic unless local-only
- No circular imports between modules

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
