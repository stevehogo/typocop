---
trigger: always_on
---

# Refactoring Documentation

Store **all refactoring documents** in `docs/refactoring/`. Never place them at the
repository root or loose in `docs/`.

A "refactoring document" is any planning, analysis, or proposal doc about
restructuring existing code — e.g. architecture/refactoring proposals, module
analyses, code-structure plans, cleanup/migration strategies, and dead-code or
coupling investigations that feed a refactor.

## Rules

- **Never edit existing docs**: do **not** modify or overwrite any existing documentation file. When a doc is stale, wrong, or needs updating (e.g. `docs/ARCHITECTURE.md`), write a **new** file in `docs/refactoring/` instead and state in its header which doc it supersedes. Treat all docs as append-only — the original stays as-is for history.
- **Location**: write the file to `docs/refactoring/<NAME>.md`. Create the folder if missing.
- **Naming**: `UPPER-KEBAB-CASE.md`, matching the existing docs (e.g. `REFACTORING-PROPOSAL.md`, `TARGET-ARCHITECTURE.md`).
- **Cross-links**: reference sibling refactoring docs by their full path under `docs/refactoring/`.
- **Header**: start each doc with a one-line status + date + branch blockquote, e.g.
  `> **Status:** Proposal · **Date:** YYYY-MM-DD · **Branch:** <branch>`. When the doc replaces another, append `· **Supersedes:** <path-to-old-doc>`.
- **Don't scatter**: bug post-mortems / incident analyses belong in `docs/issues/`; user/setup guides stay in `docs/`. Only refactoring-initiative docs go in `docs/refactoring/`.

When asked to "save", "write", or "document" a refactoring plan/analysis, default to
`docs/refactoring/` without asking.
