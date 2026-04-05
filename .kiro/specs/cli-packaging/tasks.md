# Implementation Plan: CLI Packaging

## Overview

Wire the existing `src/cli/` and `src/mcp/` modules into thin entry point files, update `package.json` with the `bin`, `files`, `engines`, and lifecycle scripts, add `.env.example`, and validate everything with unit, property-based, smoke, and integration tests.

## Tasks

- [x] 1. Create `src/cli/main.ts` — CLI entry point
  _Skills: `typescript-expert`, `error-handling-patterns`, `nodejs-best-practices`
  - Add shebang `#!/usr/bin/env node` as the first line
  - Import `parseArgs`, `executeCLI`, and `CLIValidationError` from `./index.js`
  - **UPDATE**: Strip `-e`/`--env <path>` from `process.argv` before passing to `parseArgs`
  - **UPDATE**: If `envPath` is set, check `existsSync(envPath)`; if missing → stderr + `process.exit(1)`; if present → `dotenv.config({ path: envPath })`
  - Implement `main()`: call `parseArgs(["node", "typocop", ...filteredArgv])`, catch `CLIValidationError` → stderr + `process.exit(1)`
  - Call `executeCLI(command)`, catch any error → stderr + `process.exit(1)`, on success `process.exit(0)`
  - Call `main()` at module level (no top-level await)
  - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 9.1, 9.3, 9.5_

- [x] 2. Create `src/mcp/main.ts` — MCP server entry point
  _Skills: `typescript-expert`, `error-handling-patterns`, `nodejs-best-practices`
  - Add shebang `#!/usr/bin/env node` as the first line
  - Import `startMCPServer` from `./index.js`
  - **UPDATE**: Strip `-e`/`--env <path>` from `process.argv` before starting the server
  - **UPDATE**: If `envPath` is set, check `existsSync(envPath)`; if missing → stderr + `process.exit(1)`; if present → `dotenv.config({ path: envPath })`
  - Call `startMCPServer().catch(err => { stderr write + process.exit(1) })`
  - Process must remain alive on success (no explicit exit)
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 9.2, 9.4, 9.6_

- [-] 3. Update `package.json` — bin, files, engines, scripts, and dependencies
  _Skills: `nodejs-best-practices`
  - Add `bin` field: `{ "typocop": "dist/cli/main.js", "typocop-mcp": "dist/mcp/main.js" }`
  - Add `files` field: `["dist", "README.md"]`
  - Add `engines` field: `{ "node": ">=20.0.0" }`
  - Add `scripts.prepublishOnly`: `"pnpm run build"`
  - Add `scripts.postbuild`: `"chmod +x dist/cli/main.js dist/mcp/main.js"`
  - Add `scripts.clean`: `"rm -rf dist"`
  - **NEW**: Add `dotenv` as a runtime dependency: `"dependencies": { "dotenv": "^16.0.0" }`
  - _Requirements: 1.1, 1.7, 2.1, 2.2, 2.5, 3.5, 3.6, 4.1, 8.3, 9.7_

- [ ] 4. Create `.env.example`
  _Skills: `nodejs-best-practices`
  - Document all 9 environment variables with their default values
  - Sections: Neo4j (`NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`), PostgreSQL (`POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`), OpenAI (`OPENAI_API_KEY`)
  - _Requirements: 6.1, 6.2, 6.3, 6.5_

- [ ] 5. Write unit tests for `src/cli/main.ts`
  _Skills: `testing-patterns`, `tdd-workflow`, `typescript-expert`
  - [ ] 5.1 Create `src/cli/main.test.ts` with `vi.mock` for `./index.js`
    - Mock `parseArgs`, `executeCLI`, `CLIValidationError`
    - Spy on `process.stderr.write` and `process.exit`
    - _Requirements: 1.3, 1.4, 1.5, 1.6_
  - [ ]* 5.2 Test success path: `executeCLI` resolves → `process.exit(0)`
    - _Requirements: 1.6_
  - [ ]* 5.3 Test `CLIValidationError` path: stderr receives message + `process.exit(1)`
    - _Requirements: 1.4_
  - [ ]* 5.4 Test unexpected error path: stderr receives message + `process.exit(1)`
    - _Requirements: 1.5_
  - [ ]* 5.5 Test `-e` with existing file: mock `existsSync` → `true`, mock `dotenv.config`; assert `dotenv.config` called before `parseArgs`
    - _Requirements: 9.3_
  - [ ]* 5.6 Test `-e` with missing file: mock `existsSync` → `false`; assert stderr write + `process.exit(1)` and `parseArgs`/`executeCLI` NOT called
    - _Requirements: 9.5_

- [ ] 6. Write unit tests for `src/mcp/main.ts`
  _Skills: `testing-patterns`, `tdd-workflow`, `typescript-expert`
  - [ ] 6.1 Create `src/mcp/main.test.ts` with `vi.mock` for `./index.js`
    - Mock `startMCPServer`
    - Spy on `process.stderr.write` and `process.exit`
    - _Requirements: 5.2, 5.3, 5.4_
  - [ ]* 6.2 Test success path: `startMCPServer` resolves → process does NOT call `process.exit`
    - _Requirements: 5.4_
  - [ ]* 6.3 Test failure path: `startMCPServer` rejects → stderr receives message + `process.exit(1)`
    - _Requirements: 5.3_
  - [ ]* 6.4 Test `-e` with existing file: mock `existsSync` → `true`, mock `dotenv.config`; assert `dotenv.config` called before `startMCPServer`
    - _Requirements: 9.4_
  - [ ]* 6.5 Test `-e` with missing file: mock `existsSync` → `false`; assert stderr write + `process.exit(1)` and `startMCPServer` NOT called
    - _Requirements: 9.6_

- [ ] 7. Write property-based tests (fast-check)
  _Skills: `testing-patterns`, `typescript-expert`
  - [ ]* 7.1 Property 1 — CLI entry point propagates any error to stderr
    - Use `fc.string()` to generate arbitrary error messages
    - Mock `executeCLI` to reject with `new Error(msg)`; assert stderr contains `msg` and exit code is 1
    - `numRuns: 100`
    - **Property 1: CLI error propagation**
    - **Validates: Requirements 1.4, 1.5**
  - [ ]* 7.2 Property 2 — MCP entry point propagates any error to stderr
    - Use `fc.string()` to generate arbitrary error messages
    - Mock `startMCPServer` to reject with `new Error(msg)`; assert stderr contains `msg` and exit code is 1
    - `numRuns: 100`
    - **Property 2: MCP error propagation**
    - **Validates: Requirements 5.3**
  - [ ]* 7.3 Property 3 — Unknown commands always exit with code 1
    - Use `fc.string().filter(s => !["parse","reindex","status"].includes(s))` for arbitrary unknown commands
    - Assert `parseArgs(["node", "typocop", cmd])` throws `CLIValidationError`
    - `numRuns: 100`
    - **Property 3: Unknown command rejection**
    - **Validates: Requirements 7.4**
  - [ ]* 7.4 Property 4 — Env_Flag file-not-found always exits with code 1 (CLI)
    - Use `fc.string()` to generate arbitrary path strings; mock `existsSync` to return `false`
    - Run CLI `main()` with `["-e", path]`; assert stderr write + `process.exit(1)` and `parseArgs`/`executeCLI` NOT called
    - `numRuns: 100`
    - **Property 4: Env_Flag file-not-found always exits with code 1**
    - **Validates: Requirements 9.5**
  - [ ]* 7.5 Property 4 — Env_Flag file-not-found always exits with code 1 (MCP)
    - Same as 7.4 but for MCP `main()`; assert `startMCPServer` NOT called
    - `numRuns: 100`
    - **Property 4: Env_Flag file-not-found always exits with code 1**
    - **Validates: Requirements 9.6**

- [ ] 8. Checkpoint — Ensure all unit and property tests pass
  - Run `pnpm vitest --run` and confirm all tests in `src/cli/main.test.ts` and `src/mcp/main.test.ts` pass.
  - Ask the user if questions arise.

- [ ] 9. Write smoke tests — `package.json` field assertions and shebang verification
  _Skills: `testing-patterns`
  - [ ]* 9.1 Create `tests/smoke/packaging.test.ts`
    - Import `package.json` and assert `bin`, `files`, `engines`, `scripts.build`, `scripts.prepublishOnly`, `scripts.postbuild`, `scripts.clean`, `type: "module"`, and `dependencies.dotenv` fields have the expected values
    - _Requirements: 1.1, 1.7, 2.1, 2.2, 2.5, 3.5, 3.6, 4.1, 8.3, 9.7_
  - [ ]* 9.2 Assert `.env.example` exists and contains all 9 variable names
    - Read `.env.example` with `node:fs` and assert each variable name is present
    - _Requirements: 6.5_

- [ ] 10. Write integration tests — build output, permissions, and pack dry-run
  _Skills: `testing-patterns`, `nodejs-best-practices`
  - [ ]* 10.1 Create `tests/integration/packaging.test.ts`
    - After `pnpm run build`, assert `dist/cli/main.js` and `dist/mcp/main.js` exist
    - _Requirements: 2.3, 2.4_
  - [ ]* 10.2 Assert executable permission bits on both entry point files (POSIX only, skip on Windows)
    - Use `node:fs.statSync` and check `mode & 0o111`
    - _Requirements: 8.1, 8.2_
  - [ ]* 10.3 Assert shebang line `#!/usr/bin/env node` is the first line of both compiled files
    - _Requirements: 1.2, 5.1_
  - [ ]* 10.4 Run `pnpm pack --dry-run` and assert `src/` is not listed in the output
    - _Requirements: 4.2, 4.3_

- [ ] 11. Final checkpoint — Ensure all tests pass
  - Run `pnpm vitest --run` and confirm the full test suite is green.
  - Ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Property tests use `fast-check` with `numRuns: 100` minimum
- Integration tests (task 10) require a prior `pnpm run build` — run them with `pnpm vitest --run tests/integration/packaging.test.ts`
- The `postbuild` chmod script only applies on POSIX; integration test 10.2 skips on Windows
