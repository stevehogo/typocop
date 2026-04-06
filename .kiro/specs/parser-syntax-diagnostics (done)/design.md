# Design: Parser Syntax Diagnostics

**Related documents:**
- [Correctness Properties](./design-correctness.md)

Part of the [Code Graph Analyzer](../../specs/code-graph-analyzer/design.md) project.

## Overview

Replace the single generic `console.warn` in `parseFile` with structured, actionable diagnostics.
When tree-sitter returns a partial AST (`rootNode.hasError === true`), two new modules walk the AST,
extract per-error location and snippet data, and emit formatted warnings capped at 10 per file.

The partial AST is still returned — no existing behaviour changes.

## Architecture

```mermaid
flowchart LR
    PF[parseFile\nsrc/parser/parse-file.ts] -->|tree + source| DC[DiagnosticCollector\nsrc/parser/diagnostic-collector.ts]
    DC -->|Diagnostic[]| DF[DiagnosticFormatter\nsrc/parser/diagnostic-formatter.ts]
    DC -->|Diagnostic[]| DL[DiagnosticLogger\nsrc/parser/diagnostic-logger.ts]
    DF -->|console.warn| OUT[Console]
    DL -->|NDJSON| LOG[Log File]
    PF -->|ASTNode| CALLER[Caller]
```

Integration point: the single `if (tree.rootNode.hasError)` block in `parse-file.ts` is replaced
with a call to `collectDiagnostics` followed by `emitDiagnostics`.

## Components and Interfaces

### Diagnostic (data type)

```typescript
interface Diagnostic {
  readonly filePath: string;
  readonly line: number;      // 1-based
  readonly col: number;       // 0-based
  readonly message: string;
  readonly snippet?: string;  // undefined when source is empty or line out of range
}
```

### DiagnosticCollector (`src/parser/diagnostic-collector.ts`)

```typescript
export function collectDiagnostics(
  rootNode: SyntaxNode,
  source: string,
  filePath: string,
): Diagnostic[]
```

- Walks the AST depth-first, collecting every node where `node.type === "ERROR"` or
  `node.isMissing === true`.
- Returns all diagnostics (no cap — the formatter caps display).
- Falls back to a single `"Unknown syntax error"` diagnostic at line 1, col 0 when no
  Error_Nodes are found despite `hasError` being true.

### DiagnosticLogger (`src/parser/diagnostic-logger.ts`)

```typescript
export async function logDiagnostics(
  diagnostics: Diagnostic[],
): Promise<void>
```

- Resolves the log path from `TYPOCOP_LOG_FILE` env var, falling back to
  `typocop-diagnostics.log` in `process.cwd()`.
- Overwrites the file at the start of each run (no append).
- Writes every diagnostic as a JSON object on its own line (NDJSON); the `snippet`
  field is omitted when `undefined`.
- No cap on entries written — all diagnostics are persisted.
- On write failure, emits one `console.warn` with the reason and returns without throwing.

### DiagnosticFormatter (`src/parser/diagnostic-formatter.ts`)

```typescript
export function emitDiagnostics(
  diagnostics: Diagnostic[],
  filePath: string,
): void
```

- Emits one `console.warn` per diagnostic, capped at 10.
- Appends a truncation line when `diagnostics.length > 10`.
- Pure side-effect function; no return value.

## Data Models

### Snippet extraction algorithm

Given `source` split into `lines[]` and a 0-based `errorRow`:

```
contextStart = max(0, errorRow - 1)
contextEnd   = min(lines.length - 1, errorRow + 1)
snippet      = lines[contextStart..contextEnd].join("\n")
             + "\n"
             + " ".repeat(col) + "^"
```

Edge cases:
- `source` is empty → `snippet` is `undefined`
- `errorRow >= lines.length` → `snippet` is `undefined`

### Warning format

```
[parser] <filePath>:<line>:<col> — <message>
<snippet>
```

When no snippet: the `\n<snippet>` part is omitted.

Truncation line (when `diagnostics.length > 10`):

```
[parser] … and <N> more error(s) in <filePath>
```

## Error Handling

- `collectDiagnostics` never throws; all errors in snippet extraction are caught and result in
  `snippet: undefined`.
- `emitDiagnostics` never throws; it is a best-effort warning path.
- `logDiagnostics` never throws; on any write error it emits a single `console.warn` with the
  reason and returns normally.
- `parseFile` continues to return the partial `ASTNode` regardless of diagnostic output.

## Testing Strategy

Tests live in:
- `src/parser/diagnostic-collector.test.ts`
- `src/parser/diagnostic-formatter.test.ts`
- `src/parser/diagnostic-logger.test.ts`

Unit tests cover:
- Single ERROR node → one diagnostic with correct line/col
- `isMissing` node → message `"Missing token: <type>"`
- `hasError` with no Error_Nodes → fallback diagnostic
- Empty source → `snippet` is `undefined`
- Snippet clamping at file start and end
- Formatter cap at 10 + truncation line
- Formatter with no snippet omits snippet block
- Logger writes all diagnostics to the resolved path (no cap)
- Logger uses `TYPOCOP_LOG_FILE` when set, defaults to `typocop-diagnostics.log`
- Logger emits `console.warn` and does not throw on write failure

Property tests (fast-check, 100 iterations each) are specified in
[design-correctness.md](./design-correctness.md).
