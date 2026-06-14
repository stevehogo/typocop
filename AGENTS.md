# Typocop Agent Instructions

These rules apply to the entire repository.

If anything here conflicts with a user request or system/developer instruction, follow the higher-priority instruction.

For fuller context, see `CODEX.md`.

## Project Basics

- Runtime: Node.js 20+
- Language: TypeScript (ESM / `NodeNext`)
- Package manager: `pnpm` only (never `npm` or `yarn`)

Common commands:

```bash
pnpm install
pnpm run build
pnpm test
pnpm run typecheck
```

## Coding Standards

- Prefer strict typing; do not introduce `any` (use `unknown`, unions, or explicit interfaces).
- Use ESM imports/exports consistent with the codebase.
- Add explicit return types to exported/public functions.
- Prefer `import type` for type-only imports.
- Use `async`/`await` for async flows.
- Keep files small and focused; split by responsibility when reasonable.
- Reuse shared domain types from `src/types/index.ts` rather than redefining.
- Preserve documented invariants (ordered process steps, valid line ranges, etc).

## Error Handling

- Handle I/O and database failures explicitly.
- Do not silently swallow errors in server, parser, scheduler, or adapter code.
- Retry behavior must follow the project’s documented backoff constraints.

## Testing

- Use `vitest` for unit/integration tests.
- Use `fast-check` for property-based tests.
- Do not perform real network calls in unit tests.
- Prefer targeted tests for touched modules, then `pnpm run typecheck`.

## Security and Privacy

- Never send full source code to external APIs; only the minimum allowed metadata.
- Sanitize natural-language query inputs and validate file paths.
- Keep execution/resource limits centralized in `src/utils/limits.ts`.
- Preserve redaction of secrets and sensitive values in logs and error surfaces.

## Kiro Spec Workflow

When the user asks to execute work under `.kiro/specs/`:

1. Start from `.kiro/specs/{feature}/tasks.md` and follow task links as needed.
2. Read only the minimum required context (task + relevant `design.md` and `requirements.md` files).
3. Respect any `_Skills` listed in the task and obey `.agents/rules/kiro-steering.md`.
4. Implement narrowly to the selected task; do not expand scope.
5. Verify (targeted tests, then typecheck) before marking tasks complete.
6. Update task checkboxes from `- [ ]` to `- [x]` after verification.

## Typocop MCP Usage (Prefer Tools First)

Prefer Typocop MCP tools over manual grepping/file-walking when you need symbol context, dependents, blast radius, or data flow:

- `get_symbol_context` for first-pass understanding of a symbol.
- `impact_analysis` before modifying/renaming/deleting shared symbols.
- `find_dependents` before refactors/renames.
- `trace_data_flow` for end-to-end flows (controller to DB).

Do not re-read files for information Typocop already provided unless you need exact implementation details.

## Documentation Conventions

- **Never edit or overwrite an existing documentation file.** To correct, update, or supersede a doc (e.g. a stale `docs/ARCHITECTURE.md`), write a **new** dated Markdown file in `docs/refactoring/` that states what it supersedes — leave the original untouched. Docs are append-only.
- Store **all plan documents** (implementation plans, work plans, step-by-step task plans, performance/feature plans) in `docs/plans/`. Create the folder if missing; never leave these at the repo root or loose in `docs/`. Name them `YYYY-MM-DD-<slug>.md`.
- Store **all refactoring documents** (architecture/refactoring proposals, module analyses, code-structure plans, cleanup/migration strategies) in `docs/refactoring/`. Create the folder if missing; never leave these at the repo root or loose in `docs/`. See `.agents/rules/refactoring-docs.md`.
- Bug post-mortems / incident analyses go in `docs/issues/`; user and setup guides stay in `docs/`.
- **Mermaid diagrams** in any markdown must follow `.kiro/steering/mermaid.md` for cross-renderer compatibility (VS Code, GitHub, Kiro). Gist: use `graph TD`/`graph LR` only — never `stateDiagram-v2` or `flowchart`; keep node labels short and alphanumeric (no `:` `/` `()` `<br/>` or backticks); edge labels are letters + spaces only (no `/` `,` `_` `-`); don't label dotted arrows (`-.->`); no `style`/hex-color statements (use `classDef` or omit); keep diagrams under ~30 nodes. See the rule file for the full reference and examples.

## Directories to Treat Carefully

- `legacy-parser/` is reference material; do not modify unless explicitly requested.
- `proto/` changes affect the gRPC boundary and require tighter verification.
- `src/db-server/` and `src/db/` changes often require both unit tests and type checks.
- `src/security/` is high-sensitivity; preserve privacy guarantees.

