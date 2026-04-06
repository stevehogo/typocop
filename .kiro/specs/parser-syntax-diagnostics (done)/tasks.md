# Implementation Plan: Parser Syntax Diagnostics

## Overview

Implement `DiagnosticCollector`, `DiagnosticFormatter`, and `DiagnosticLogger`, then wire them into
`parseFile`. Property-based tests use `fast-check` (Properties 1–9 from `design-correctness.md`).

## Tasks

- [x] 1. Implement DiagnosticCollector
  _Skills: `typescript-expert`, `clean-code`, `error-handling-patterns`
  - [x] 1.1 Create `src/parser/diagnostic-collector.ts` with `collectDiagnostics`
    - Walk AST depth-first; collect nodes where `type === "ERROR"` or `isMissing === true`
    - Extract snippet per design algorithm; return `undefined` on empty source or out-of-range row
    - Return fallback diagnostic `"Unknown syntax error"` at line 1, col 0 when no Error_Nodes found
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4_
  - [ ]* 1.2 Write unit tests in `src/parser/diagnostic-collector.test.ts`
    - Single ERROR node → one diagnostic with correct line/col
    - `isMissing` node → message `"Missing token: <type>"`
    - `hasError` with no Error_Nodes → fallback diagnostic
    - Empty source and out-of-range row → `snippet` is `undefined`
    - Snippet clamping at file start and end
    - _Requirements: 1.1–1.5, 2.1–2.4_
  - [ ]* 1.3 Write property tests for DiagnosticCollector
    - **Property 1**: Collector returns one diagnostic per Error_Node — _Requirements: 1.1, 4.3_
    - **Property 2**: Diagnostic location matches node `startPosition` — _Requirements: 1.2_
    - **Property 3**: Missing-node message encodes the node type — _Requirements: 1.3_
    - **Property 4**: Snippet context window is clamped to file bounds — _Requirements: 2.2_
    - **Property 5**: Caret is positioned at the error column — _Requirements: 2.3_

- [x] 2. Implement DiagnosticFormatter
  _Skills: `typescript-expert`, `clean-code`
  - [x] 2.1 Create `src/parser/diagnostic-formatter.ts` with `emitDiagnostics`
    - Emit one `console.warn` per diagnostic, capped at 10
    - Append truncation line `[parser] … and <N> more error(s) in <filePath>` when count > 10
    - Omit snippet block when `diagnostic.snippet` is `undefined`
    - _Requirements: 3.1, 3.2, 3.3, 4.1, 4.2_
  - [ ]* 2.2 Write unit tests in `src/parser/diagnostic-formatter.test.ts`
    - Cap at 10 + truncation line present
    - ≤10 diagnostics → no truncation line
    - Diagnostic without snippet omits snippet block
    - _Requirements: 3.1–3.3, 4.1, 4.2_
  - [ ]* 2.3 Write property tests for DiagnosticFormatter
    - **Property 6**: Warning format is correct for all diagnostics — _Requirements: 3.2_
    - **Property 7**: Formatter caps at 10 and appends accurate truncation line — _Requirements: 3.1, 4.1, 4.2_

- [x] 3. Implement DiagnosticLogger
  _Skills: `typescript-expert`, `clean-code`, `error-handling-patterns`, `nodejs-best-practices`
  - [x] 3.1 Create `src/parser/diagnostic-logger.ts` with `logDiagnostics`
    - Resolve log path from `TYPOCOP_LOG_FILE` env var, fallback to `typocop-diagnostics.log` in `cwd`
    - Overwrite file each run; write all diagnostics as NDJSON (omit `snippet` when `undefined`)
    - On write failure: emit one `console.warn` with reason, return without throwing
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_
  - [ ]* 3.2 Write unit tests in `src/parser/diagnostic-logger.test.ts`
    - Writes all diagnostics (no cap), uses `TYPOCOP_LOG_FILE` when set, defaults to `typocop-diagnostics.log`
    - Emits `console.warn` and does not throw on write failure
    - _Requirements: 5.1–5.6_
  - [ ]* 3.3 Write property tests for DiagnosticLogger
    - **Property 8**: Logger writes all diagnostics with no cap — _Requirements: 5.1_
    - **Property 9**: Each log entry is valid NDJSON with required fields — _Requirements: 5.3_

- [x] 4. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Wire into parseFile
  _Skills: `typescript-expert`, `clean-code`
  - [x] 5.1 Update `src/parser/parse-file.ts` to call `collectDiagnostics`, `emitDiagnostics`, and `logDiagnostics`
    - Replace the existing `if (tree.rootNode.hasError)` block
    - Call formatter and logger after collecting; still return the partial `ASTNode`
    - _Requirements: 3.4_

- [x] 6. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked `*` are optional and can be skipped for a faster MVP
- Property tests use `fast-check` with `numRuns: 100`; tag each: `Feature: parser-syntax-diagnostics, Property <N>`
- `logDiagnostics` is `async`; `emitDiagnostics` is synchronous — call order in `parseFile`: collect → emit → log (awaited)
