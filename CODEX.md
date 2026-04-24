# Typocop — Codex Instructions

## Project Overview

Typocop is a TypeScript/Node.js code graph analyzer that parses source code with tree-sitter, stores graph and vector data in LadybugDB, and exposes CLI, MCP, and gRPC server entrypoints.

- Runtime: Node.js 20+
- Language: TypeScript with ESM (`NodeNext`)
- Package manager: `pnpm`
- Core subsystems: CLI, parser, query engine, MCP server, LadybugDB adapters, gRPC connection server

## Package Manager

Always use `pnpm`. Do not use `npm` or `yarn`.

```bash
pnpm install
pnpm run build
pnpm test
pnpm run typecheck
```

Useful scripts from `package.json`:

- `pnpm run build` — compile TypeScript to `dist/`
- `pnpm test` — run Vitest once
- `pnpm run typecheck` — run `tsc --noEmit`
- `pnpm run clean` — remove `dist/`

## Coding Standards

### TypeScript and Modules

- Prefer strict typing. Do not introduce `any`; use `unknown`, discriminated unions, or explicit interfaces.
- Use ESM imports/exports consistent with the existing codebase.
- Add explicit return types to public functions.
- Use `import type` for type-only imports when practical.
- Use `async`/`await` for asynchronous flows.

### Project Conventions

- Keep source files under 250 lines when feasible; split by responsibility.
- Follow existing file naming patterns in `src/`, which are predominantly `kebab-case.ts`.
- Do not put logic in `src/types/`; shared domain types should live there and be imported elsewhere.
- Reuse core types from `src/types/index.ts` instead of redefining them inline.
- Preserve documented invariants such as ordered process steps and valid line ranges.

### Error Handling

- Handle I/O and database failures explicitly.
- Prefer typed errors or typed result boundaries over silent failure.
- Do not swallow errors in server, parser, scheduler, or adapter code.
- Database retry behavior must follow the project’s documented backoff constraints.

## Testing

### Frameworks

- Use `vitest` for unit and integration tests.
- Use `fast-check` for property-based tests.

### Test Placement

- Most unit and property tests are colocated next to source files in `src/`.
- Integration tests live in `tests/integration/`.
- Smoke/package assertions live in `tests/smoke/`.

### Test Expectations

- Follow Arrange-Act-Assert structure.
- Prefer focused tests for the touched area before broader suite runs.
- Do not perform real network calls in unit tests.
- For correctness/property work, preserve or extend the invariants defined in `design-correctness.md`.

Common verification commands:

```bash
pnpm test
pnpm run typecheck
pnpm test -- src/db-server
pnpm test -- tests/integration
```

## Security and Resource Constraints

- Never send full source code to external APIs; only the minimum allowed metadata.
- Sanitize natural language query inputs and validate file paths.
- Keep execution/resource limits centralized in `src/utils/limits.ts`.
- Preserve redaction of secrets and sensitive values in logs and error surfaces.

## Kiro Spec Workflow

When the user asks to execute a spec task, continue a phase, or resume work under `.kiro/specs/`, follow this workflow:

### 1. Find the correct task file

Start with:

```text
.kiro/specs/{feature}/tasks.md
```

Then follow links to sibling task files such as `tasks-client.md`, `tasks-testing.md`, or `tasks-02-*.md` if the task is split out.

Do not assume old `tasks-phaseN.md` naming. This repo uses multiple task file shapes.

### 2. Read the minimum required context

Before editing code:

1. Read the selected task and all of its subtasks.
2. Read `design.md` and only the relevant design sub-files.
3. Read `requirements.md` and any `requirements-*.md` files referenced by the task.
4. Read the existing source files you will modify.

### 3. Respect `_Skills` and project rules

- Activate every skill listed in the task’s `_Skills`.
- Obey `.agents/rules/kiro-steering.md`.
- Treat `.agents/rules/kiro-builder.md` as potentially stale for the “active spec” field; verify against the user’s request and the current unfinished spec files before relying on it.

### 4. Implement narrowly

- Follow task file paths, signatures, and constraints exactly.
- Do not expand scope beyond the selected task unless required to make the task correct.
- Checkpoint tasks are verification tasks first, not feature tasks.

### 5. Verify before marking complete

Run the smallest useful verification set first:

- targeted Vitest tests for touched modules
- `pnpm run typecheck`
- broader integration tests only when the task requires them

Do not mark a task complete while known failures remain.

### 6. Update task checkboxes

After successful verification:

- Change completed subtasks from `- [ ]` to `- [x]`
- Mark the parent task complete only when its required subtasks are done
- Preserve `_Skills`, `_Requirements`, and formatting

## Current Architecture Focus

This repo includes several completed specs and one active area of recent work around the LadybugDB connection server:

- `.kiro/specs/ladybugdb-connection-server/`

That spec introduces:

- a standalone gRPC connection server
- remote database adapters for CLI/MCP/query clients
- scheduler, metrics, auth, discovery, and autostart flows

If the user refers to “the current spec” without naming it, verify against the unfinished task files instead of assuming the old `code-graph-analyzer` spec is still active.

## Files and Directories to Treat Carefully

- `legacy-parser/` is read-only reference material if present; do not modify it.
- `proto/` changes affect the gRPC boundary and require tighter verification.
- `src/db-server/` and `src/db/` changes often require both unit tests and type checks.
- `src/security/` changes are high-sensitivity and should preserve privacy guarantees.

## Preferred Codex Behavior

- Use `rg` / `rg --files` for discovery.
- Use `apply_patch` for manual file edits.
- Keep diffs small and task-focused.
- Preserve unrelated user changes.
- Report what changed, what was verified, and any remaining risk or blocker.

## Typocop MCP Server Usage

The `typocop` MCP server is always available and provides precomputed code graph intelligence for this workspace. It answers questions about symbols, dependencies, and data flows in a single query — no iterative file searches needed.

Source of truth: `.kiro/steering/typocop-mcp-usage.md`

### When to Use Typocop Tools

Always prefer typocop tools over manual file reads or grep searches when you need to:

- Understand what a function/class/method does and how it connects to the rest of the codebase
- Assess the blast radius before modifying, renaming, or deleting a symbol
- Trace how data flows from an API endpoint through services to the database
- Find all callers of a symbol before refactoring it
- Understand which clusters and processes a symbol belongs to

### Available Tools

#### `get_symbol_context`

360 degree view of a symbol: callers, callees, clusters, and processes it belongs to.

```text
symbolName: string   (required) — name of the symbol
filePath: string     (optional) — narrow down if name is ambiguous
maxResults: number   (optional, default 50)
```

Use this first when starting work on any task that touches an existing symbol.

#### `find_dependents`

All direct and transitive callers of a symbol. Use before any refactor or rename.

```text
symbolName: string   (required)
maxDepth: number     (optional) — limit traversal depth
maxResults: number   (optional, default 50)
```

#### `trace_data_flow`

Traces execution from an API endpoint through services down to database models.

```text
entryPoint: string   (required) — controller method, route handler, etc.
framework: string    (optional) — NestJS, Laravel, Express, etc.
maxResults: number   (optional, default 50)
```

Use when implementing or debugging a feature that spans multiple layers.

#### `impact_analysis`

Blast radius analysis: affected symbols, flows, and risk level (LOW/MEDIUM/HIGH/CRITICAL).

```text
symbolName: string                          (required)
changeType: "modify" | "delete" | "rename"  (optional, default "modify")
maxResults: number                          (optional, default 50)
```

Always run this before modifying a shared utility, interface, or core service.

### Task Execution Workflow

When executing any spec task:

1. Call `get_symbol_context` on the primary symbol(s) the task touches
2. If the task involves modifying an existing symbol, call `impact_analysis` first
3. If the task involves a new API endpoint or data flow, call `trace_data_flow` to understand the existing pattern
4. Use the results to inform implementation — do not re-read files that typocop already covered

### Connection Details

The server connects to an embedded LadybugDB (Kuzu) database stored locally. The default path is `~/.typocop/{prefix}/db.ladybug`.

If a tool call fails with a connection error, the database file may not exist yet (run the indexer first).
