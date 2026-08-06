---
name: writing-wave-plans
description: "Write a multi-wave implementation plan: a folder with a README + one file per wave, each owning its status tracking. Use for a 'wave plan', per-wave state tracking, or a master plan over a backlog or estimation sheet (~10+ tasks, phases, parallel tracks). For one feature use writing-plans."
risk: safe
source: self
date_added: "2026-07-15"
---

# Writing multi-wave plans

**Announce at start:** "I'm using the writing-wave-plans skill to create the implementation plan."

## When to Use

Use the **multi-wave folder** format when ANY of these hold:

- a backlog / estimation source with ~10+ rows;
- multiple categories with a dependency spine (a foundation layer the rest build on);
- a phased or staged rollout;
- parallelizable tracks;
- the user asks for a "wave plan", a master plan covering a whole estimation sheet, per-wave state tracking, or a build plan with an architecture design.

Use **plain `superpowers:writing-plans`** (a single file) for one feature or fix.

**Project type is irrelevant** — the format fits frontend, backend/API, data/ETL, CLI, library, and infra work alike; the examples in this skill span domains, and the exemplars show one frontend plan ([`references/exemplar-plan.md`](references/exemplar-plan.md)) and one backend architecture ([`references/exemplar-architecture.md`](references/exemplar-architecture.md)).

**Inherits `superpowers:writing-plans`** — read/apply its discipline first: assume zero context, bite-sized tasks (one 2–5-min action per step), exact file paths, complete code where it's knowable at plan time, exact verification commands with expected output, DRY/YAGNI, one commit per task, and its execution-handoff question at the end. (If that skill isn't available in the environment, the summary in this sentence IS the discipline — proceed without it.) This skill adds the *folder structure, traceability, and verification layers* for efforts too big for one file.

### What this adds over `writing-plans`

| Layer | Step |
|---|---|
| **Reality-baseline survey before writing** — repo facts, toolchain pins, and what the *execution environment* can actually verify (gates may only demand runnable checks) | 1 |
| **Backlog-ID traceability** — every backlog row becomes exactly one task heading | 2 |
| **Dependency graph** with parallel tracks | 2–3 |
| **Per-wave verification gates** — build/tests → fresh-context audit → triage fix-vs-defer → remediation commit → tester-facing testing summary → context checkpoint | 3 |
| **Optional `ARCHITECTURE.md`** — principles, C4 views, ADRs, wave↔architecture coverage map; for efforts that *build or reshape* a system rather than transform within one | 3 |
| **Optional per-feature `design-<feature>.md`** — overview, components & interfaces, data models, correctness properties; for a feature whose *how* must be settled before its tasks | 3 |
| **Post-write verification pass**, so the plan ships pre-checked | 4 |

**Save to:** `docs/plans/YYYY-MM-DD-<effort>/` in the target repo (or the repo's own plan-folder convention if its CLAUDE.md declares one).

## Step 1 — Survey reality first (never trust docs)

The plan is only as good as its facts. Before writing a single task:

1. **Dump the backlog source completely** — a spreadsheet (`python3` + openpyxl), a GitHub/Jira/Linear export, or a markdown checklist. Capture every row ID, category, size, dependency, and note. Count the rows; the plan must account for all of them.
2. **Verify the current state of every load-bearing claim with greps/reads** — do NOT trust prior docs, memories, skill descriptions, or the backlog's own notes: they may describe a reverted, stale, or never-landed tree. Confirm: files/dirs the tasks will name, line numbers you cite, tokens/config values you'll call "current", how things are wired (build pipelines, entry points, test harness).
3. **Verify the tooling you'll reference:** scripts in `package.json` (or equivalent), workflow/skill arg schemas and exact dimension/option keys, agents available. A gate step that passes invalid args is a broken plan.
4. **Probe the execution environment, not just the repo.** Which verification rungs can actually run where the plan will execute: build? unit tests? e2e (browsers installed?)? a dev server? network? real devices? Record a **Verification capability** line in the Reality baseline, plus the **toolchain versions the gates depend on** (runtime, package manager, compiler-critical deps — pin anything a float would break, and record mid-effort pins back here). Then design the verification ladder against it: every rung the environment can't run gets a named degraded form (e.g. build + targeted greps + fresh-context read-only reviewer agents when there's no browser), and whatever can't be verified in-session is routed to a human-facing checklist (the wave's testing summary) and recorded as *"not verified in-session"* in the gate's status line — never silently dropped or, worse, claimed.
5. **Study prior art:** any earlier wave-plan folders in the target repo, plus archived plans for the same area — cite them as *decision history*, flagging where their values are superseded. For a filled-in example of the format itself, see [`references/exemplar-plan.md`](references/exemplar-plan.md). Scale the depth to the backlog — skim a prior plan's README for small efforts. Where a prior plan's formatting differs from `references/templates.md`, the templates are canonical.
6. Record findings as the README's **Reality baseline** section; if upstream docs/sheets have stale cells, add a **corrections table** (cell → stale claim → actual/authoritative value) so no executor follows the stale value. If authoritative docs are wrong about reality, the plan's first task (an `X0`) fixes them.

## Step 2 — Design the waves

- Group backlog categories into waves along the **dependency spine** — the thing everything else depends on becomes wave 0, then each wave builds on the ones before. **Derive the spine from the backlog's actual dependency cells; don't impose a frontend shape.** Common spines by project type:
    - *Frontend/UI:* design tokens → primitives → composite components → global chrome → pages → cross-cutting QA
    - *Backend/API:* schema + migrations → service/domain layer → transport (REST/RPC/GraphQL) → auth → external integrations → QA/release
    - *Data/ETL:* source schema + connectors → ingestion → transforms/models → orchestration & scheduling → monitoring/alerting
    - *CLI/library:* core types + errors → internal primitives → public API surface → commands/adapters → docs & packaging
  One wave ≈ one category or one coherent theme. **Number waves from 0** — wave 0 is the foundation everything else depends on. Small efforts may merge adjacent spine stages into one wave; keep the merged categories visible in the wave title.
- **Traceability is a hard rule:** every backlog row maps to exactly one `### Task <ID> — <name>` heading, keeping the source's IDs. Extra plan-only tasks get suffixed IDs (`F0` baseline, `W3-GATE`, `FINAL`).
- Honor every dependency cell from the source; identify **parallel tracks** (waves sharing no files) and say when they may run concurrently.
- Order risk deliberately — the riskiest, hardest-to-reverse work late, behind cheap reversible groundwork (e.g. the payment/checkout flow or a table-rewriting migration last; additive, zero-behavior-change scaffold or token commits first).
- Human/process-only tasks (sign-off, device passes, releases) stay IN the plan, explicitly marked "human — agent prepares, doesn't perform".
- **End with a cross-cutting QA/release wave** (the spines above all do). Besides its own backlog rows, it is the **landing zone for gate-deferred findings**: every wave gate re-homes what it doesn't fix onto named tasks there, so deferrals accumulate against owners instead of evaporating. If the backlog has no such rows, add a plan-only `QA-FINAL` task to hold them.
- **Decide whether the effort needs an `ARCHITECTURE.md`** (Step 3, Template 3): yes when the plan *builds or reshapes a system* — new services/apps, data stores/schemas, transports, trust boundaries, a new module/folder layout. No for transformations within an existing architecture (restyles, content/value migrations) — the README's Architecture paragraph carries those.
- **Decide which features (if any) need a `design-<feature>.md`** (Step 3, Template 4): a per-feature design document for any feature whose *how* must be settled before its task steps — non-trivial control flow, interacting components with concrete interfaces/data models, or invariants worth property-testing. It's a *different artifact* from `ARCHITECTURE.md`: architecture is the program-wide shape (one per plan, spans all waves); a design doc is one feature's mechanism (zero or more per plan, scoped to the wave that builds it). Most straightforward CRUD/config waves need none.

## Step 3 — Write the folder

`docs/plans/YYYY-MM-DD-<effort>/` containing `README.md` + `wave-N-<theme>.md` per wave.

**Start from the skeletons in [`references/templates.md`](references/templates.md)** — copy and fill; don't re-derive the markup. The section lists below are the rationale and review checklist for what the templates already contain.

**Scale the blocks to the effort.** Small plans may compact a task block — Covers/Files merged onto one line, Steps inlined — as long as the invariants survive: the `### Task <ID> — ` heading, exact file paths, an exact verify command, and a commit line. If the target repo has no audit skills/workflows for gates, degrade gates to build + tests + targeted greps and write "none exist — follow Steps directly" in those template slots rather than leaving placeholders.

**README.md (orchestrator) — required sections:**
1. Title + `Status: not started` line + created/branch/coverage line ("Covers all N rows of …").
2. `> **For Claude:**` preamble: execute task-by-task, one commit per task; **each wave file owns its task-level status tracking**; roll wave results up to the README table; which skills to use; keep the plan in sync with reality as work progresses (and per the project's CLAUDE.md plan conventions, if any). **The plan is a living doc:** when execution uncovers a recurring gotcha (a build quirk, an ordering rule, a naming trap), promote it into the shared conventions *then*; when work is reassigned between tasks/waves (a file turns out to belong elsewhere, a step is deferred), record it in **both** affected status sections — later waves must inherit lessons, not rediscover them.
3. **Goal / Architecture / Tech stack** (per writing-plans header).
4. **Reality baseline** + stale-docs corrections table (from Step 1).
5. **Wave files table** (wave · file link · theme · backlog rows).
6. **Dependency graph** (ASCII) + recommended execution order incl. parallel tracks.
7. **Shared conventions** — the DRY home for rules every task obeys (spec authority; verification ladder *matched to the capability baseline*; commit format `<type>(scope): <ID> — <what>`; do-not-touch list; and the field-proven regression guards: **no invented identifiers** — any class/token/util/symbol a task newly references is grep-proven to exist before commit; **shared surfaces extend additively** — new keys in shared maps/enums/barrels are safe, re-valuing an existing key needs a consumer sweep by a task that owns it; **dead code stays dead** — don't migrate commented-out/unused blocks, note them for the cleanup task; **per-wave testing summary** — see the gate). Wave files never repeat these.
8. **Status tracking (wave rollup)** — one row per wave + Final verification. Legend: `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked (note why). Task-level state does NOT live here.
9. **Final verification** checklist + **References** (spec, backlog, archived plans, tooling).

**Each wave file — required sections:**
1. Header blockquote: part-of link to README, "read shared conventions first", skills + spec sections for this wave, a **Design:** link to the feature's `design-<feature>.md` when the wave implements a designed feature, prev/next wave links.
2. **Depends on / Unblocks** lines.
3. **`## Status tracking — Wave N`** — its own `Status:` line + a checklist with one row per task + the gate. *This section is the single source of truth for the wave's task state* (the user-facing reason this format exists). **Tick with evidence:** a done line carries the commit hash + a one-line delta + any deviation from the plan; the gate line additionally records verification results (build/tests/audit verdicts), what was **not verifiable in-session** (per the capability baseline), and every deferral with its new owner task ID. That record — not the executor's memory — is what makes gates lossless compaction points.
4. Optional **task template** — the wave's repeated steps written once; per-task content is then only the deltas.
5. **Tasks** (`### Task <ID> — …`): Covers (ID, size, depends) · Files (exact paths; `Create:`/`Modify:` + line anchors where known) · Spec (values/quotes with source-section references; cite the feature's design-doc section where one exists) · Steps (inventory → change → verify → commit, per writing-plans granularity).
6. **`### Task WN-GATE`** — wave verification gate, in this order (field-tested; every step earned its place):
   **(a) Build + the test rungs the capability baseline says are runnable** — golden/snapshot artifacts (visual screenshots, API/contract fixtures, CLI golden files) re-baselined only for *intended* changes, diffs eyeballed first; unrunnable rungs execute their degraded form and are recorded "not verified in-session", never claimed.
   **(b) Fresh-context audit** — the relevant audit workflow(s) with **exact valid args**, or standalone read-only reviewer agents where workflows need an opt-in the session may lack. Scope = the wave's surface **plus the shared/global files it touched**. The reviewer must not be the executor re-reading its own diff: in practice gates catch both executor-introduced regressions (a renamed-to-nonexistent class) and pre-existing global killers (a `!important` that nullifies the wave's work).
   **(c) Triage** — split findings into fix-now (in-scope high/medium + cheap nits) vs defer; every deferral is re-homed onto a **named later task ID** (usually the QA wave) and recorded in the gate's status line.
   **(d) Remediation commit** — `fix(<scope>): WN gate — remediate audit findings` (skip if nothing to fix).
   **(e) Testing summary** — write/refresh the wave's tester-facing summary (*what changed · how to verify · what is intentionally NOT changed yet* — the last section prevents false-regression reports while the tree is deliberately half-migrated) in a summaries folder outside the plan (e.g. `docs/<effort>-summary/`), plus its index row.
   **(f) Sync docs + gate commit** — wave Status (with evidence, see §3), README rollup row (outcome + env caveats + deferrals), any external checklist tooling reads; then a `docs(...)` gate commit.
   **(g) Context checkpoint** — the executor stops after the gate commit and invites the user to `/compact` or `/clear` before the next wave. The executor can't compact context itself (`/compact` is user-invoked), but a passed gate is where compaction is lossless *by construction* — every fact the next wave needs is already on disk (wave Status sections, README rollup, git history), so the plan directs compaction to happen there rather than mid-wave.
7. Footer: "Wave N done when …" → link to next wave.

**Optional artifacts.** Two more documents may belong in the folder; most plans need neither. Full guidance, decision table, and hard rules: [`references/optional-artifacts.md`](references/optional-artifacts.md).

- **`ARCHITECTURE.md`** (Template 3) — one per plan, program-wide shape. Add it only when Step 2 decided the effort *builds or reshapes* a system. It introduces **no new decisions**; the README's **Architecture:** line must link it.
- **`design-<feature>.md`** (Template 4) — zero or more per plan, one feature's mechanism. Add one for each feature Step 2 flagged as needing its *how* settled before task steps. The wave that builds the feature must link it.

Both use Mermaid diagrams obeying [`references/mermaid.md`](references/mermaid.md), never ASCII, and the verifier fails either one if it is left unwired.

## Step 4 — Verify the plan before handing it off

Ship the plan pre-verified; fix defects in the plan files (this is authoring, not executing):

1. **Run the canned verifier** (don't re-improvise it). Iterate until PASS:

   ```
   node <skill-base-dir>/scripts/verify-plan.mjs <plan-folder> --ids "F1-F8,U1-U11,E1-E2,…"
   ```

   **Flags.** `--ids` is mandatory — without it the run fails rather than silently skipping coverage. Ranges keep zero-padding (`F01-F03` → F01, F02, F03); a mixed-prefix range (`F1-U3`) is an error, not a silent expansion. `--ids-from-readme` derives the list from the README wave-files table and additionally checks each wave file holds the rows attributed to it. `--no-ids` skips coverage — only for a plan with genuinely no backlog source. `--strict` turns warnings into failures.

   **It fails on:** backlog IDs with missing or duplicate `### Task <ID> —` headings · broken internal links · a wave file lacking a `## Status tracking` section, `Status:` line, or gate task · a `wave-*.md` the README never references (orphan wave — dropped work) · a README with no rollup · an unwired `ARCHITECTURE.md` · any `design*.md` no non-design plan file links, directly or via its spine.

   **It warns on:** referenced repo paths that don't exist (to-be-created dirs and deliberately-quoted stale paths are legitimate — review each) · package scripts the plan invokes (`yarn x` / `npm run x` / `pnpm x`) that the root `package.json` doesn't define — the classic "gate demands a test suite the repo doesn't have" defect; write the degraded form instead.

   Editing the verifier? Run its regression suite: `node <skill-base-dir>/scripts/test-verify-plan.mjs`.
2. **Anchor check (manual):** spot-check cited line numbers — the script verifies paths, not line contents.
3. **Spec fidelity:** re-read the authority doc for every quoted value (scales, state specs, durations); where the plan encodes a value the spec *doesn't* state, add a provenance note rather than implying it's spec'd.
4. **Tooling check:** every workflow/skill/script invocation in gates uses names, args, and option keys that actually exist — **and is runnable in the execution environment** per the capability baseline (a script `package.json` doesn't define, or an e2e rung with no browsers installed, is a broken gate: write its degraded form instead).
5. **Blast-radius sanity:** any step that edits a *shared or generated* file — one whose changes fan out to many outputs — must name the actual mechanism and scope before claiming the change is local. Examples across stacks: an SCSS partial auto-injected per-component vs imported once globally; a barrel/`index` re-export; a codegen source or template; a base class, a DI/service registration, a shared config or migration. Confirm how the file is consumed.
6. **Command dry-run:** any verification command whose *exact output* the plan asserts — run it (in a scratch copy with the change hand-applied, if it needs the change). Classic traps: `grep -c` counts LINES, not occurrences; multi-file grep output order isn't stable across runs/tools (ugrep vs GNU grep); locale-dependent sorting.
7. **Diagram compatibility (if an `ARCHITECTURE.md` or any `design*.md` exists):** every ` ```mermaid ` block obeys [`references/mermaid.md`](references/mermaid.md) — `graph TD`/`graph LR`/`sequenceDiagram` only (no `stateDiagram-v2`, no `(( ))` nodes), no hex `style` declarations, and node/edge/message labels use only the safe characters in that file's table. Paste one into a renderer if unsure it parses.
8. **Record the outcome:** append `> Plan verified: <date> — verify-plan.mjs PASS; manual checks 2–7 done (<one-line notes>)` at the bottom of the plan README — "verified" must be a recorded state, not a memory.

## Backlog drift — when the source moves after the plan is written

Traceability is a hard rule (Step 2) and the verifier enforces it against a fixed ID set, so a backlog that changes mid-effort breaks the invariant unless drift is handled deliberately. On a multi-wave effort it *will* change. Write this protocol into **Shared conventions** so the executor follows it rather than improvising:

| What changed | What to do |
|---|---|
| **Row added** | Add one `### Task <ID> —` heading to the wave that owns its place on the dependency spine — a later wave if its dependencies aren't met yet. Add it to that wave's Status checklist and the README's row list. |
| **Row removed / obsoleted** | Never delete the heading. Retitle it `### Task <ID> — <name> (withdrawn <date>: <why>)` and tick it `[x]` with that note. A deleted ID makes git history unreadable. |
| **Row split** | Keep the original ID as a suffixed pair (`F4a`, `F4b`) and note the split in both headings. Update the README row list. |
| **Row moved between waves** | Move the heading, and record the move in **both** wave Status sections — the one losing it and the one gaining it. |
| **Wave re-cut** | Update the README wave-files table, the dependency graph, and — if it exists — `ARCHITECTURE.md`'s build-sequence coverage table. |

Three rules keep the ledger honest:

- **IDs are append-only.** Never renumber. Commit messages carry IDs, so a renumber silently re-points history.
- **Record drift where it happened** — the affected wave's Status section, not just the README. A later wave must inherit the change, not rediscover it.
- **Re-verify after any drift:** re-run Step 4's verifier with the updated ID list. `--ids-from-readme` derives that list from the README wave-files table and additionally checks each wave file actually contains the rows the table attributes to it — which is what catches a table that drifted out of sync with its own waves.

## Execution handoff

After saving + verifying, offer the writing-plans choice: **1. Subagent-driven (this session)** — fresh subagent per task, review between tasks; **2. Wave-per-subagent (this session)** — a fresh subagent executes each wave and only gate results return to the orchestrator, so every wave starts with clean context (what compaction approximates, without needing it); or **3. Parallel session** — new session executes wave-by-wave with the gates as checkpoints (`superpowers:executing-plans`, or the environment's equivalent executing-plans skill, if available).

Whichever mode: wave gates are the plan's designed compaction points — each gate ends with the context-checkpoint step (flush state to disk, stop, invite `/compact`/`/clear`), so long executions shed context at lossless boundaries instead of arbitrary mid-task auto-compaction.
