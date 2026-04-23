---
inclusion: fileMatch
fileMatchPattern: "src/**"
---

# Testing Strategy

## Testing Stack

- **Property-based tests**: `fast-check` — for correctness properties
- **Unit tests**: `vitest` — for specific examples and edge cases
- **Integration tests**: `vitest` — for end-to-end pipeline validation

Run tests with:
```bash
npx vitest --run
```

## Test File Location

Co-locate tests with source files inside each phase folder:
```
src/
  indexer/
    structure/
      index.ts
      index.test.ts        # Phase 1 tests
    parsing/
      index.ts
      index.test.ts        # Phase 2 tests
    resolution/
      index.ts
      index.test.ts        # Phase 3 tests
      symbol-table.ts
    clustering/
      index.ts
      index.test.ts        # Phase 4 tests (upcoming)
    processes/
      index.ts
      index.test.ts        # Phase 5 tests (upcoming)
    search/
      index.ts
      index.test.ts        # Phase 6 tests (upcoming)
  query/
    execute-query.ts
    execute-query.test.ts
```

Integration tests go in:
```
tests/
  integration/
    pipeline.test.ts
    query-types.test.ts
    mcp-integration.test.ts
```

## Property-Based Tests (fast-check)

All 21 correctness properties from `design-correctness.md` must be implemented. Each property test file should import from `fast-check` and use `fc.assert` + `fc.property`.

### Required Arbitraries

Define reusable arbitraries in `src/types/arbitraries.ts`:

```typescript
import * as fc from "fast-check";
import type { Symbol, Location, Cluster, Process, Relationship, SearchResult, QueryResult } from "./index.js";

export const locationArbitrary = (): fc.Arbitrary<Location> =>
  fc.record({
    filePath: fc.string({ minLength: 1 }),
    startLine: fc.nat(),
    startColumn: fc.nat(),
    endLine: fc.nat(),
    endColumn: fc.nat(),
  }).map(loc => ({
    ...loc,
    endLine: loc.startLine + fc.sample(fc.nat({ max: 100 }), 1)[0],
  }));

export const symbolArbitrary = (): fc.Arbitrary<Symbol> => { ... };
export const clusterArbitrary = (): fc.Arbitrary<Cluster> => { ... };
export const processArbitrary = (): fc.Arbitrary<Process> => { ... };
export const searchResultArbitrary = (): fc.Arbitrary<SearchResult> => { ... };
export const queryResultArbitrary = (): fc.Arbitrary<QueryResult> => { ... };
```

### Property Test Checklist

All properties below must have passing tests before implementation is considered complete:

| Property | File | Validates |
|----------|------|-----------|
| 1: Symbol Uniqueness | `parsing/index.test.ts` | Req 4.1, 4.3 |
| 2: Relationship Validity | `resolution/index.test.ts` | Req 5.5, 5.7 |
| 3: Symbol Location Validity | `parsing/index.test.ts` | Req 4.4, 4.5 |
| 4: Cluster Confidence Bounds | `clustering/index.test.ts` | Req 6.2 |
| 5: Cluster Minimum Size | `clustering/index.test.ts` | Req 6.4 |
| 6: Cluster Symbol Validity | `clustering/index.test.ts` | Req 6.5 |
| 7: Process Step Ordering | `processes/index.test.ts` | Req 7.4 |
| 8: Process Minimum Length | `processes/index.test.ts` | Req 7.6 |
| 9: Query Result Limit | `execute-query.test.ts` | Req 9.6 |
| 10: Query Confidence Bounds | `execute-query.test.ts` | Req 9.4, 21.2 |
| 11: High Confidence Completeness | `execute-query.test.ts` | Req 9.7, 21.3, 21.4 |
| 12: Risk Level Consistency | `impact-analysis.test.ts` | Req 10.4-10.7 |
| 13: Intent Classification Confidence | `classify-intent.test.ts` | Req 9.2, 21.6, 24.3 |
| 14: Embedding Dimensionality | `search/index.test.ts` | Req 8.3 |
| 15: Search Result Ordering | `semantic-search.test.ts` | Req 17.4 |
| 16: Framework Tracing Completeness | `data-flow-trace.test.ts` | Req 13.7, 14.8 |
| 17: Framework Partial Tracing | `framework-support.test.ts` | Req 14.9, 25.4 |
| 18: Graph Traversal Depth Limit | `graph-db.test.ts` | Req 16.7 |
| 19: Input Sanitization | `security.test.ts` | Req 22.3 |
| 20: Path Validation | `security.test.ts` | Req 22.4 |
| 21: Framework Support Invariant | `framework-support.test.ts` | Req 25.1-25.3 |

## Unit Test Guidelines

- All tests should follow the AAA pattern (Arrange-Act-Assert)
- Test one function per `describe` block
- Cover happy path, error path, and edge cases
- Use `vi.mock` for external dependencies (LadybugDB, Ollama)
- Never make real network calls in unit tests

```typescript
import { describe, it, expect, vi } from "vitest";

describe("resolveImport", () => {
  it("returns target symbol ID when import resolves", () => { ... });
  it("returns null when import cannot be resolved", () => { ... });
  it("marks relationship as unresolved in metadata", () => { ... });
});
```

## Integration Test Guidelines

Integration tests use real in-process instances where possible, or embedded LadybugDB for DB tests.

Required integration test scenarios (task 28.4):
- Full indexing pipeline on sample TypeScript, PHP, and JavaScript projects
- All five query types against a pre-indexed graph
- MCP tool calls with mock editor client — verify `summary` field is present
- NestJS and Laravel framework-specific parsing
- `reindex` and `status` CLI commands against an existing database
- Confidence >= 0.90 on production-representative queries

## Test Data

Sample codebases for integration tests live in:
```
tests/fixtures/
  typescript-sample/    # NestJS-style project
  php-sample/           # Laravel-style project
  javascript-sample/    # Express-style project
```

Keep fixtures minimal — just enough to exercise each query type and framework parser.
