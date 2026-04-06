# Correctness Properties: Parser Syntax Diagnostics

Part of the [Parser Syntax Diagnostics Design](./design.md).

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a
system — essentially, a formal statement about what the system should do. Properties serve as the
bridge between human-readable specifications and machine-verifiable correctness guarantees.*

Property-based tests use `fast-check` with `numRuns: 100`. Each test is tagged:
`Feature: parser-syntax-diagnostics, Property <N>: <text>`

---

### Property 1: Collector returns one diagnostic per Error_Node

*For any* AST containing N Error_Nodes (type `"ERROR"` or `isMissing === true`),
`collectDiagnostics` SHALL return exactly N diagnostics.

**Validates: Requirements 1.1, 4.3**

---

### Property 2: Diagnostic location matches node startPosition

*For any* Error_Node with `startPosition { row, column }`, the resulting diagnostic SHALL have
`line === row + 1` and `col === column`.

**Validates: Requirements 1.2**

---

### Property 3: Missing-node message encodes the node type

*For any* node type string `T`, a missing node of type `T` SHALL produce a diagnostic with
message `"Missing token: T"`.

**Validates: Requirements 1.3**

---

### Property 4: Snippet context window is clamped to file bounds

*For any* source text with L lines and any valid error row R (0 ≤ R < L), the snippet SHALL
contain exactly the lines `max(0, R-1)` through `min(L-1, R+1)` — no more, no fewer.

**Validates: Requirements 2.2**

---

### Property 5: Caret is positioned at the error column

*For any* error column C, the last line of the snippet SHALL be exactly `" ".repeat(C) + "^"`.

**Validates: Requirements 2.3**

---

### Property 6: Formatter warning format is correct for all diagnostics

*For any* diagnostic with fields `filePath`, `line`, `col`, `message`, the formatted
`console.warn` argument SHALL start with
`[parser] <filePath>:<line>:<col> — <message>`.

**Validates: Requirements 3.2**

---

### Property 7: Formatter caps output at 10 and appends accurate truncation line

*For any* list of N diagnostics:
- If N ≤ 10, `console.warn` is called exactly N times (one per diagnostic).
- If N > 10, `console.warn` is called exactly 11 times: 10 diagnostic lines plus one truncation
  line containing `"and " + (N - 10) + " more error(s)"`.

**Validates: Requirements 3.1, 4.1, 4.2**

---

### Property 8: Logger writes all diagnostics with no cap

*For any* list of N diagnostics (including N > 10), `logDiagnostics` SHALL write exactly N
lines to the log file — one per diagnostic — with no truncation.

**Validates: Requirements 5.1**

---

### Property 9: Each log entry is valid NDJSON with required fields

*For any* diagnostic with fields `filePath`, `line`, `col`, `message`, and optional `snippet`,
the corresponding log line SHALL be valid JSON containing exactly those fields (with `snippet`
omitted when `undefined`), and parsing it SHALL produce an object equal to the original diagnostic.

**Validates: Requirements 5.3**
