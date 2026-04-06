# Requirements Document

## Introduction

When tree-sitter returns a partial AST due to syntax errors in a source file, the parser currently
emits a single generic warning with no location or context. This feature replaces that warning with
actionable diagnostics: exact line/column of each error node, the offending source snippet, and a
human-readable message that helps the user understand and fix the problem.

## Glossary

- **Diagnostic**: A structured record describing one syntax error, including its location, source
  snippet, and message.
- **Error_Node**: A tree-sitter `SyntaxNode` whose `type` is `"ERROR"` or `isMissing` is `true`.
- **Diagnostic_Collector**: The module responsible for walking the AST, finding Error_Nodes, and
  producing Diagnostic records.
- **Diagnostic_Formatter**: The module responsible for rendering a Diagnostic into a human-readable
  string for console output.
- **Parser**: The `parseFile` function in `src/parser/parse-file.ts` (Phase 2 of the indexing
  pipeline).
- **Snippet**: Up to 3 lines of source text centred on the error line, with a caret (`^`) marker
  pointing to the error column.
- **Diagnostic_Logger**: The module responsible for persisting all Diagnostic records to a log file
  in NDJSON format.

## Requirements

### Requirement 1: Collect per-error diagnostics from the AST

**User Story:** As a developer running the indexer, I want each syntax error to be reported with its
exact location, so that I can open the file and fix the problem without guessing.

#### Acceptance Criteria

1. WHEN `tree.rootNode.hasError` is `true`, THE Diagnostic_Collector SHALL traverse the AST and
   return one Diagnostic for every Error_Node found.
2. THE Diagnostic_Collector SHALL record the 1-based line number and 0-based column number of each
   Error_Node's `startPosition`.
3. WHEN an Error_Node has `isMissing === true`, THE Diagnostic_Collector SHALL set the Diagnostic
   message to `"Missing token: <nodeType>"`.
4. WHEN an Error_Node has `type === "ERROR"`, THE Diagnostic_Collector SHALL set the Diagnostic
   message to `"Unexpected token"`.
5. IF the AST contains no Error_Nodes despite `hasError` being `true`, THE Diagnostic_Collector
   SHALL return a single Diagnostic with message `"Unknown syntax error"` at line 1, column 0.

### Requirement 2: Attach source snippets to diagnostics

**User Story:** As a developer, I want to see the problematic code inline in the warning, so that I
can identify the error without opening the file.

#### Acceptance Criteria

1. THE Diagnostic_Collector SHALL extract a Snippet from the source text for each Diagnostic.
2. THE Snippet SHALL include the error line and up to 1 line before and 1 line after it (clamped to
   file bounds).
3. THE Snippet SHALL include a caret line (`^`) positioned at the error column beneath the error
   line.
4. IF the source text is empty or the error line index is out of range, THE Diagnostic_Collector
   SHALL omit the Snippet and leave the `snippet` field `undefined`.

### Requirement 3: Emit structured, actionable console warnings

**User Story:** As a developer, I want the console output to clearly show file path, line, column,
message, and snippet in one block, so that I can act on it immediately.

#### Acceptance Criteria

1. WHEN at least one Diagnostic is collected, THE Diagnostic_Formatter SHALL emit one `console.warn`
   call per Diagnostic (replacing the current single generic warning).
2. THE Diagnostic_Formatter SHALL format each warning as:
   `[parser] <filePath>:<line>:<col> — <message>\n<snippet>`.
3. WHERE the Diagnostic has no Snippet, THE Diagnostic_Formatter SHALL omit the snippet block from
   the output.
4. THE Parser SHALL call the Diagnostic_Formatter after parsing and before returning the ASTNode,
   preserving the existing behaviour of returning a partial AST rather than throwing.

### Requirement 4: Limit diagnostic output for large error counts

**User Story:** As a developer, I want the output to stay readable even when a file has many errors,
so that the console is not flooded.

#### Acceptance Criteria

1. WHEN the number of collected Diagnostics exceeds 10, THE Diagnostic_Formatter SHALL emit warnings
   for the first 10 Diagnostics only.
2. WHEN Diagnostics are truncated, THE Diagnostic_Formatter SHALL append one additional `console.warn`
   line: `[parser] … and <N> more error(s) in <filePath>`.
3. THE Diagnostic_Collector SHALL still collect all Error_Nodes regardless of the display limit, so
   that the count in the truncation message is accurate.

### Requirement 5: Persist all diagnostics to a log file

**User Story:** As a developer, I want every diagnostic written to a log file, so that I can review
the full history of parse errors after a run without being limited by console truncation.

#### Acceptance Criteria

1. WHEN at least one Diagnostic is collected, THE Diagnostic_Logger SHALL write all Diagnostics to
   a log file, with no cap on the number of entries written.
2. THE Diagnostic_Logger SHALL overwrite the log file at the start of each run, so that the file
   reflects only the most recent indexing pass.
3. THE Diagnostic_Logger SHALL write each Diagnostic as a JSON object on its own line (NDJSON
   format) with fields: `filePath`, `line`, `col`, `message`, and `snippet` (omitted when
   `undefined`).
4. WHERE a `TYPOCOP_LOG_FILE` environment variable is set, THE Diagnostic_Logger SHALL write to
   the path it specifies.
5. IF the `TYPOCOP_LOG_FILE` environment variable is not set, THE Diagnostic_Logger SHALL write to
   `typocop-diagnostics.log` in the current working directory.
6. IF the log file cannot be written (e.g. permission error), THE Diagnostic_Logger SHALL emit a
   single `console.warn` with the reason and continue without throwing.
