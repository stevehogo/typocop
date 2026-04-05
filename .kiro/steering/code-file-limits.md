---
inclusion: fileMatch
fileMatchPattern: "src/**"
---

# Code File Size Limits

## Rule: No source file should exceed 250 lines of code

When creating or updating any source file, keep it under 250 lines. This enforces single-responsibility, improves readability, and makes files easier to test in isolation.

## When a file would exceed 250 lines

Split it by responsibility. Examples:

```
// Too big — split it
src/query/execute-query.ts  (300 lines)

// After split
src/query/execute-query.ts        ← orchestration, public API
src/query/build-graph-query.ts    ← graph traversal logic
src/query/build-vector-query.ts   ← semantic search logic
src/query/format-result.ts        ← result formatting
```

```
// Too big — split it
src/indexer/phase4-clustering.ts  (280 lines)

// After split
src/indexer/phase4-clustering.ts          ← pipeline entry point
src/indexer/phase4-louvain.ts             ← Louvain algorithm
src/indexer/phase4-cluster-enrichment.ts  ← AI enrichment
```

## Splitting guidelines

- Split by **single responsibility** — one concern per file
- Keep the main file as the public entry point / orchestrator
- Move implementation details into focused helper files
- Co-locate test files with their source file (same directory)
- Update imports in all affected files after splitting

## Applies to

All source files under `src/`:
- `.ts` TypeScript source files
- `.js` JavaScript source files
- Does **not** apply to generated files, fixtures, or lock files

## Enforcement

Before writing or appending to any source file, estimate the resulting line count. If it would exceed 250 lines, split the file first, then write.
