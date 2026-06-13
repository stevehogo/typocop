---
name: refactor-typocop
description: "Execute the Typocop layered-architecture refactor one PR-sized, test-guarded step at a time. Use when asked to refactor Typocop, advance the migration, move a module into the core/platform/infrastructure/application/apps layers, break a dependency cycle, extract remote-transport, delete the dead enrichment module, or run the next refactor step. Drives the plan in docs/refactoring/TARGET-ARCHITECTURE.md with strangler shims, ts-morph import rewrites, and per-PR green gates."
risk: caution
source: "Generated from docs/refactoring/TARGET-ARCHITECTURE.md + REFACTORING-PROPOSAL.md"
date_added: "2026-06-13"
---

# Refactor Typocop — layered-architecture migration driver

> Move Typocop to the five-layer architecture **one PR-sized, test-guarded step at a time.** Never a big-bang. Every step ends green or is reverted.

The full design, file map, constraints, and PR ladder already live in the docs — **this skill is the *process* for executing them safely**, not a re-statement. Treat the docs as the single source of truth; if they conflict with this file, the docs win and this file should be corrected.

## 🎯 Selective reading — read only what the step needs

| Source | What it is | Read when |
|--------|-----------|-----------|
| `docs/refactoring/TARGET-ARCHITECTURE.md` **§15** | The PR-by-PR migration plan (the checklist you execute) | **Always, first** — to find the next step |
| TARGET-ARCHITECTURE **§13** | Build/tooling constraints (ESM, no path aliases, entry points, proto path) | Before any file move |
| TARGET-ARCHITECTURE **§14** | The prerequisite embedding-adapter inversion | Before touching `db`/persistence/remote-transport |
| TARGET-ARCHITECTURE **§10** | dependency-cruiser config + import-rewrite mechanism | PR 0, and whenever wiring the linter |
| TARGET-ARCHITECTURE **§4 / §9** | Per-module target spec + exhaustive old→new file map | When moving a specific module |
| TARGET-ARCHITECTURE **§16** | Risk register | When a step feels risky |
| `docs/refactoring/REFACTORING-PROPOSAL.md` | The *why* + cycle/dead-code evidence | Background only |
| `scripts/verify.sh` | Per-PR green gate (typecheck + tests + depcruise) | End of every step |
| `scripts/blast-radius.sh` | Count importers of a module to scope a move | Planning a module move |

## ⛔ Hard rules (non-negotiable)

1. **One PR-sized step per invocation.** Follow the §15 ladder order (PR 0 → 9). Do not start a step whose prerequisites aren't merged. Default to *the next unfinished step* unless the user names one.
2. **Green gate or revert.** A step is done only when `scripts/verify.sh` passes (`pnpm typecheck && pnpm test`, plus `typecheck:tests` and `depcruise src` once they exist). If it can't go green, revert the step — don't leave the tree half-moved.
3. **Strangler, not big-bang.** When moving files, leave a **re-export shim** at the old path (old file re-exports from the new location) so importers keep compiling; rewrite imports as a trailing pass. Remove shims only in the final cleanup (PR 9).
4. **Relative imports + a ts-morph codemod — NEVER `tsconfig` path aliases.** Build is plain `tsc` on NodeNext ESM; `paths` aliases do not survive emit and break at runtime (§13.1). Rewrite imports (with their `.js` extensions, in source *and* co-located tests) via a codemod, not by hand for large moves.
5. **Embedding inversion is a prerequisite (PR 4), do it before the infra split.** `database-adapter.ts` and `remote-database-adapter.ts` statically import concrete embedding adapters — that becomes a forbidden `infra → sibling infra` edge. Invert to an injected `EmbeddingAdapter` port first (§14).
6. **`core/` imports nothing; dependencies point strictly down; no sibling imports** (the one allowance: everything may import `infrastructure/remote-transport`). The linter enforces this — keep it green.
7. **Branch + commit per step.** Work on a feature branch; one focused commit per PR step; the commit message names the step (e.g. `refactor(PR2): extract core/ — domain, ports, FileNode`). Don't push or open PRs unless asked.
8. **Respect doc conventions.** Never edit existing docs to record progress — if a step needs a new doc, create a new dated file in `docs/refactoring/` (see `.agents/rules/refactoring-docs.md`). Any Mermaid you add follows `.kiro/steering/mermaid.md`.
9. **Update entry-point wiring with the apps (PR 8).** `package.json` `bin` + `postbuild`, `main`, `src/index.ts`, and the `import.meta.url`-relative proto path all hardcode the old layout (§13.3). Smoke-test all three binaries after.

## 🔄 Execution workflow (per invocation)

1. **Orient.** Read TARGET-ARCHITECTURE §15. Inspect the working tree (`git status`, `git log --oneline`, `ls src/`) to determine which PR steps are already done and which is **next**. State it.
2. **Confirm scope.** If the user named a step, use it (but refuse if its prerequisites aren't done — say why). Otherwise take the next unfinished step.
3. **Plan the step.** Re-read the relevant §4/§9/§13/§14 slices for that step. Run `scripts/blast-radius.sh <module>` to size it. List: files to move, shims to add, imports to rewrite, linter rules to enable, entry-point edits.
4. **Execute (strangler order):** create the new location → move files (`git mv` to keep history) → add re-export shims at old paths → codemod the importers → enable/extend the dependency-cruiser rule(s) for the layer touched.
5. **Verify.** Run `scripts/verify.sh`. Must be green. If red, fix or revert — never finish red.
6. **Commit.** One commit on the branch, message naming the step.
7. **Report.** Summarize: step done, files moved, blast radius handled, gate result, and the next step.

## 🪜 The PR ladder (summary — detail in §15)

`0` tooling (depcruise + baseline, `tsconfig.tests.json`) → `1` delete dead enrichment, move `intent.ts` → `2` **`core/`** (domain + ports + FileNode; ~111 import sites, codemod) → `3` **`platform/`** (config+Obsidian config, security, utils, logging, bootstrap) → `4` **embedding inversion (prereq)** → `5` **`remote-transport/`** (breaks Cycle A) → `6` `parsing` + split `persistence`/`embeddings` → `7` **`application/`** (indexing, querying, export-render) → `8` **`apps/`** (+ bin/postbuild/main/proto wiring) → `9` **`tests/`** + remove shims + empty baseline.

Cycles broken: **A** at PR 5, **B** at PR 3, **C** at PR 2. Dead code removed: PR 1.

## ✅ Verification

```bash
bash .agents/skills/refactor-typocop/scripts/verify.sh          # per-step green gate
bash .agents/skills/refactor-typocop/scripts/blast-radius.sh db # scope a module move
```

## 🛑 Stop and ask the user when

- The **enrichment Option A (revive) vs Option B (delete)** decision matters for the step (§8/§12) — it's the one open product call. Default to **Option B (delete)** only if told to proceed without input.
- A move can't be made green without changing behavior (i.e. it's not a pure move) and isn't the planned §14 inversion.
- The next step's prerequisites aren't merged, or the working tree has unrelated uncommitted changes that would muddy the step's commit.
