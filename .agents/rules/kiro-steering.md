# Kiro-Antigravity Steering Rules (Code Graph Analyzer)

## 1. File Size & Directory Constraints
- **Source Code Files**: Max **250 lines**. If exceeding, split by single responsibility. No logic in `src/types/`. Files must be `kebab-case.ts`.
- **Spec Files**: Max **500 lines**. If exceeding, split and link sub-files.
- **Legacy Parser (`legacy-parser/`)**: **READ-ONLY**. Do not modify, refactor, or delete files here. Use solely as reference for porting log to `src/`.

## 2. Coding Standards
- **TypeScript Strict**: `"strict": true`, ESM modules (`"type": "module"`), Node.js (no browser APIs). Async operations must use `async/await`.
- **Typing Rules**: NO `any` (use `unknown`). Provide explicit return types on all public functions. Prefer discriminated unions over optional fields and `readonly` for non-mutated data.
- **Error Handling**: Handle I/O errors explicitly (typed results/subclasses) rather than swallowing them silently. Database connections must enforce an exponential backoff retry (max 3 times).

## 3. Data Models (`src/types/index.ts`)
- **No Inline Redefinitions**: Always import core types (`Symbol`, `Relationship`, `Cluster`, `Process`, `QueryIntent`) from `src/types/index.ts`.
- **Strict Invariants**: Enforce documented properties (e.g., `startLine <= endLine`, `symbols.length >= 2` for a `Cluster`, `steps[i].order === i`).
- **MCP Response**: Ensure the `summary` property is strictly provided for ALL AI editor responses.

## 4. Testing Strategy (AAA Pattern)
- **Frameworks**: `fast-check` for correctness properties, `vitest` for unit/integration.
- **Structure**: Tests MUST follow the **AAA (Arrange-Act-Assert)** pattern.
- **Co-location**: Put unit and property test files directly alongside the source (`feature.test.ts` next to `feature.ts`). Integration tests go in `tests/integration/`.
- **Coverage**: All 21 correctness properties from `design-correctness.md` must be implemented before calling an implementation "complete".
- **Mocking**: Use `vi.mock` for dependencies; never perform real network calls in unit tests.

## 5. Security & Resource Limits
- **Security Check**: Never send full source code to external APIs; only send symbol signatures. Sanitize natural language queries. Validate file paths (to avoid traversal attacks).
- **Limits**: Define execution constraints (e.g. max file size, max graph size, query timeout) inside `src/utils/limits.ts`.
- **Performance**: Adhere strictly to specified throughput requirements (e.g. ≥ 10,000 LOC/s indexing throughput, < 500ms for simple queries).
