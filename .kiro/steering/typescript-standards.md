---
inclusion: fileMatch
fileMatchPattern: "src/**"
---

# TypeScript Standards

This extends the general coding standards with TypeScript-specific rules for the Code Graph Analyzer project.

## Type Safety Rules

- No `any` — use `unknown` and narrow with type guards
- All public functions must have explicit return type annotations
- Prefer discriminated unions over optional fields for variant types
- Use `readonly` on data model interfaces where mutation is not intended
- Prefer `type` aliases for unions/primitives, `interface` for object shapes
- Enable all strict mode flags in tsconfig.json

```typescript
// Good
interface Symbol {
  readonly id: string;
  readonly name: string;
  readonly kind: SymbolKind;
}

type SymbolKind = "function" | "class" | "method" | "interface";

export function parseFile(path: string): Promise<Symbol[]> {
  // explicit return type
}

// Bad
const process = (x: any) => { ... }  // no any, no implicit return type
```

## Import/Export Conventions

- Use named exports only — no default exports
- Group imports in this order:
  1. Node.js built-ins (`node:fs`, `node:path`)
  2. External libraries (`tree-sitter`, `neo4j-driver`)
  3. Internal modules (`../types`, `./utils`)
- Use absolute imports with path mapping for cross-module imports
- Each subfolder exports its public API via `index.ts`

```typescript
// Good
import { readFile } from "node:fs/promises";
import Parser from "tree-sitter";
import { Symbol, Location } from "../types/index.js";
import { shouldIgnorePath } from "./ignore.js";

export { parseFile, extractSymbols };

// Bad
export default function parseFile() { ... }  // no default exports
```

## Error Handling Patterns

- All I/O operations must handle errors explicitly
- Use typed error results or throw typed Error subclasses
- Never swallow errors silently
- Database connection failures: retry with exponential backoff (max 3 attempts)
- Unparseable files: log warning with file path + error, skip and continue
- Pipeline phase failures: log error and halt pipeline

```typescript
// Retry pattern for DB connections
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await sleep(Math.pow(2, attempt) * 100);
    }
  }
  throw new Error("unreachable");
}

// Typed error handling
class ParseError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly cause: unknown
  ) {
    super(`Failed to parse ${filePath}`);
  }
}
```

## Async/Await Rules

- All async operations use `async/await` — never raw Promise chains
- Use `Promise.all()` for parallel operations
- Use `Promise.allSettled()` when some operations may fail
- Always await async calls in try/catch blocks for proper error handling

```typescript
// Good
async function parseFiles(paths: string[]): Promise<Symbol[]> {
  const results = await Promise.all(paths.map(p => parseFile(p)));
  return results.flat();
}

// Bad
function parseFiles(paths: string[]): Promise<Symbol[]> {
  return Promise.all(paths.map(p => parseFile(p)))
    .then(results => results.flat());  // no promise chains
}
```

## Naming Conventions

- Files: `kebab-case.ts`
- Classes/Interfaces/Types: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE`
- Enum values: `camelCase` (matching string literal union pattern)

## Code Organization

- Keep functions pure when possible (no side effects)
- Prefer composition over inheritance
- Use dependency injection for testability
- Extract magic numbers and strings to named constants
- Co-locate types with their usage when they're not shared

## Performance Considerations

- Use `for...of` for async iteration, not `.forEach()`
- Avoid unnecessary object spreading in hot paths
- Use `Map` and `Set` for O(1) lookups instead of arrays
- Cache expensive computations (AST parsing, embeddings)
- Stream large files instead of loading into memory

## Testing Integration

- All public functions must have unit tests
- Use `vitest` for unit and integration tests
- Use `fast-check` for property-based tests
- Mock external dependencies (Neo4j, pgvector, OpenAI)
- Never make real network calls in unit tests
- Co-locate test files with source: `index.ts` → `index.test.ts`
