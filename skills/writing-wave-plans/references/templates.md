# Templates: multi-wave plan folder

Copy these skeletons and fill every `<placeholder>`. Delete guidance comments (`<!-- … -->`).
Structure is normative — `scripts/verify-plan.py` checks for the marked sections. Add sections
freely; don't remove the required ones. Number waves from 0 (wave 0 = the foundation wave).
Small plans may compact task blocks (Covers/Files merged, Steps inlined) — the invariants are
the `### Task <ID> — ` heading, exact paths, an exact verify command, and a commit line.

---

## Template 1 — `README.md` (orchestrator)

```markdown
# <Effort Name> — Master Plan (multi-wave)

Status: not started
Created: <YYYY-MM-DD> · Branch: `<branch>` · Covers **all <N> rows** of <backlog source, e.g. the Estimation sheet in docs/<file>.xlsx>.

> **For Claude:** Execute task-by-task, one commit per task. Each wave is its own file in this
> folder and **owns its task-level status tracking** — update the wave file's *Status tracking*
> section as you work, then roll the wave-level result up to the [Status tracking](#status-tracking-wave-rollup)
> table below. Use the skills named in each task. Keep these files in sync with reality as work
> progresses<, and per the project's CLAUDE.md plan conventions if it has them>. **This plan is a
> living doc:** when execution uncovers a recurring gotcha, promote it into *Shared conventions*
> right away; when work moves between tasks/waves or a step is deferred, record it in **both**
> affected status sections — later waves inherit lessons instead of rediscovering them. Stop at each
> wave gate's **context checkpoint** (the gate's last step): announce the wave is done and let the
> user `/compact` or `/clear` — or hand the next wave to a fresh session — before continuing.

**Goal:** <one sentence — what this delivers when done>

**Architecture:** <2–4 sentences — the strategy: what goes first and why, how consumers migrate
(e.g. two-step add → migrate → retire), what's staged and in what risk order>

**Tech stack:** <frameworks, build system, test harness — what an executor with zero context needs to know exists>

---

## Reality baseline (read before Wave 0)

<!-- REQUIRED. From the Step 1 survey. State what the tree ACTUALLY looks like today,
     especially where it contradicts docs/backlog notes. -->
- <verified fact about current state>
- ⚠️ **Stale docs:** <doc/cell> claims <X>; actual: <Y>. Task <X0> reconciles them before code changes.
- **Toolchain:** <runtime, package manager, compiler-critical dep versions the gates depend on —
  pin anything a float would break; record pins made mid-effort back here>
- **Verification capability (execution environment):** build <✓/✗> · unit <✓/✗> · e2e/browsers <✓/✗>
  · dev server <✓/✗> · network <✓/✗> · devices <✓/✗> — gates only demand the runnable rungs; each
  missing rung gets a named degraded form, and what can't be verified in-session routes to the wave
  testing summaries as human checks (recorded, never claimed).

<!-- If a backlog/spec has stale cells, include the corrections table: -->
| Source cell | Says (stale) | Actual / authoritative |
|---|---|---|
| <cell> | <stale claim> | <truth + ruling reference> |

## Wave files

| Wave | File | Theme | Backlog rows |
|---|---|---|---|
| 0 | [wave-0-<theme>.md](wave-0-<theme>.md) | <theme> | <IDs> |
| 1 | [wave-1-<theme>.md](wave-1-<theme>.md) | <theme> | <IDs> |

## Dependency graph

```
WAVE 0 — <theme>  ← everything depends on this
   │
   ▼
WAVE 1 — <theme>          [<task-level dep notes>]
   │
   ├──────────────┬───────────────┐
   ▼              ▼               │
WAVE 2 — <A>   WAVE 3 — <B>       │  <which tracks are parallel and why (no shared files)>
   └──────┬───────┘               │
          ▼                       │
   WAVE N — <converge>
```

**Single executor (default):** 0 → 1 → … **Parallel tracks:** after Wave <k>, <track A> and <track B> share no files — run concurrently, reconverge before Wave <m>.

## Shared conventions (read once, applies to every task)

<!-- REQUIRED. The DRY home for every-task rules. Wave files must NOT repeat these. Typical entries: -->
- **Spec first.** <authority doc>; when anything disagrees with it, <authority> wins.
- **Verification ladder:** per task = <cheap check the environment can run>; per wave gate = <build + runnable test rungs + fresh-context audits> (degraded forms per the Reality baseline's capability line).
- **Commits:** one per task, on `<branch>`, message `<type>(<scope>): <ID> — <what>`. Do not push unless asked.
- **No invented identifiers.** Any class/token/util/symbol a task newly references must be grep-proven to exist (in its defining file) before commit — renames are the classic silent breakage.
- **Shared surfaces extend additively.** Adding keys to shared maps/enums/barrels is safe; re-valuing an existing key requires a consumer sweep by a task that owns that key.
- **Dead code stays dead.** Don't migrate commented-out/unused blocks — note them for the cleanup task; never enable dead behavior mid-migration.
- **Per-wave testing summary:** at each gate, write/refresh `docs/<effort>-summary/wave-<N>-<theme>.md` — *what changed · how to verify · what is intentionally NOT changed yet* (prevents false-regression reports while the tree is deliberately half-migrated) — and add its row to that folder's index README.
- **Keep state truthful:** after each task, tick the wave file's checklist; after each gate, update this README's rollup and <any external checklist tooling reads>.
- <do-not-touch list / hard rules>

## Status tracking (wave rollup)

Task-level state lives in each wave file — this table is the wave-level rollup. Legend: `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked (note why).

<!-- A done wave's Notes cell carries: headline outcome · env caveats (what was NOT verifiable
     in-session) · deferrals with their owner task IDs. That density is what makes the rollup a
     sufficient resume point after /compact or /clear. -->

| Wave | Status | Notes |
|---|---|---|
| 0 — <theme> (<IDs>) | [ ] | |
| 1 — <theme> (<IDs>) | [ ] | |
| Final verification | [ ] | |

## Final verification (after all waves)

1. <build/test suite fully green>
2. <audit workflows / review passes clean>
3. <greps that must return clean>
4. <all wave files [x]; external checklists ticked; manual passes recorded>
5. <deferral ledger empty: every gate-deferred finding closed by its owner task — or explicitly accepted, with a note>
6. <items the environment could never verify in-session have been human-verified via the testing summaries>

## References

- **Spec:** <authority doc(s)>
- **Backlog:** <estimation sheet / issue list> (IDs used throughout)
- **Prior art:** <archived plans — decision history only; where they cite superseded values, <authority> wins>
- **Tooling:** <skills / workflows / agents the tasks invoke — or "none exist — follow Steps directly">

<!-- Appended by Step 4 once verification passes: -->
> Plan verified: <YYYY-MM-DD> — verify-plan.py PASS; manual checks done (<one-line notes>)
```

---

## Template 3 — `ARCHITECTURE.md` (optional — only when the effort builds or reshapes a system)

<!-- Add this file when the plan CREATES structure: new services/apps, new data stores or schemas,
     new transports/trust boundaries, a changed module layout. Skip it for transformations within an
     existing architecture (restyles, migrations of content/values) — there the README's
     **Architecture:** paragraph is enough. Litmus test: if you're writing rejected-alternatives and
     dependency rules to justify the README blurb, promote them here.
     Wire it: the README's **Architecture:** line links to this file; verify-plan.py FAILS an
     unwired ARCHITECTURE.md. Keep the Status line current at wave gates. Scale to the effort:
     small systems may collapse §2–4 into one diagram + §5, and drop §10 if deploy is unchanged.
     Every diagram (C4 views §2–4, runtime flows §7) is a Mermaid fenced block that follows
     references/mermaid.md — a hard cross-renderer compatibility ruleset, not a suggestion.
     Filled-in example: exemplar-architecture.md (this folder). -->

```markdown
# <Effort Name> — Architecture Design

**Created:** <YYYY-MM-DD> · **Status:** <design locked | draft> — build <not started | Wave N done, see README roll-up> · **Stack:** <one line>

> **What this document is.** The architectural reference for the build program — the *shape* of the
> system and *why it holds that shape*. It introduces **no new decisions** — every choice traces to
> <the decisions/spec source>. Where it goes beyond that source it only *consolidates* scattered
> facts and *surfaces* second-order consequences (§13).
>
> | Document | Answers | Authority for |
> |---|---|---|
> | <spec / decisions doc> | *What* & *why* | scope, decisions |
> | **this file** | *How it's shaped & fits together* | views, module layout, flows, ADRs, boundaries |
> | [wave files](README.md) | *How to build it, task by task* | steps, gates, commits |
<!-- If the plan has feature design docs (Template 4), add a row so the authority split is explicit:
     | design-<feature>.md | *How ONE feature works* | that feature's mechanism, interfaces, correctness properties | -->

## 1. Architectural principles (the load-bearing rules)
<!-- Numbered rules, each with a *Consequence:*. Open with: "If a change would violate one, it is
     wrong by construction — stop and reconsider." These are what reviewers cite in code review. -->

## 2. System context (C4 L1)
## 3. Containers (C4 L2)
## 4. Components & the dependency rule (C4 L3)
<!-- Draw C4 views (§2–4) as Mermaid `graph TD`/`graph LR` blocks that OBEY references/mermaid.md
     (safe-character labels only, no nested subgraphs >1 deep, no hex `style`, no `(( ))` nodes).
     State the dependency rule explicitly in prose (what may import what) — the arrows show it, the
     sentence enforces it. -->

## 5. Canonical module layout
<!-- The one directory tree everything else references. -->

## 6. Data architecture
<!-- Stores + roles, tables/entities grouped by lifecycle, derived-not-stored rules, enum parity. -->

## 7. Runtime flows
<!-- One numbered flow per critical path — e.g. a read path, a write/mutation path, login/auth,
     an external call, a job/pipeline run. Name the wave that delivers each flow. Draw each as a
     Mermaid `sequenceDiagram` (or `graph TD` for branch/state flow) obeying references/mermaid.md:
     messages use letters and spaces only — no `()`, `{}`, `,`, `_`, `-`, `/`, or `Note over`.
     If a feature has its own design-<feature>.md, keep the flow here program-level and LINK the
     design doc for the mechanism — never draw the same flow in both places (they will drift). -->

## 8. Security & trust boundaries
## 9. Cross-cutting concerns
## 10. Deployment architecture

## 11. Architecture Decision Records
<!-- ADR-NNN — <title>. *Context:* … *Decision:* … *Rejected:* <alternatives + why not> …
     *Consequences:* <incl. costs>. Never rewrite history: amendments and supersessions are DATED
     notes on the original ADR ("Superseded for X by ADR-0NN", "*Amendment (<date>):* …").
     ADRs are PROGRAM-WIDE; feature-local decisions live in that feature's design-<feature>.md
     (its Key Design Decisions section) — don't record the same decision in both artifacts. -->

## 12. Build sequence ↔ architecture coverage
<!-- The contract between this doc and the wave files — update it if waves are re-cut. -->
| Wave | Architectural slice delivered |
|---|---|
| 0 | <slice> |

**Extension seams already designed in:** <the future changes this shape absorbs without rework>.

## 13. Risks & recommended refinements
<!-- Second-order consequences the design implies, flagged before production. Each: the risk, then
     *Recommend:* or the seam to pull if it bites. None may silently change a decision. -->

## 14. Glossary
| Term | Meaning here |
|---|---|
```

---

## Template 2 — `wave-N-<theme>.md`

```markdown
# Wave <N> — <Theme> (<ID-range>)

> Part of the [<Effort Name> master plan](README.md). Read the [shared conventions](README.md#shared-conventions-read-once-applies-to-every-task) first. Skills: **`<skill>`**. Spec sections: <§refs for this wave>.
> <**Design:** [design-<feature>.md](design-<feature>.md) — this wave implements it; read it before the tasks. Drop this line when the wave has no design doc.>
> **Prev:** [Wave <N-1>](wave-<N-1>-<theme>.md) · **Next:** [Wave <N+1>](wave-<N+1>-<theme>.md)

**Depends on:** <waves/tasks>. **Unblocks:** <waves/tasks>.
<!-- Optional: wave-wide warnings — blast radius, "nothing visual changes until task X", etc. -->

## Status tracking — Wave <N>

Status: not started

- [ ] <ID1> — <task name>
- [ ] <ID2> — <task name>
- [ ] W<N>-GATE — Wave verification gate

<!-- Tick with EVIDENCE, not bare [x]: append the commit hash + a one-line delta + any deviation
     from the plan, e.g.
       - [x] U1 — Buttons to spec — `a1b2c3d`. Primary/outline restyled; deviation: scroll-shadow
         not wired (no scroll handler exists — applied at rest, noted).
     The GATE line additionally records: build/test/audit results, what was NOT verifiable in this
     environment, and each deferral with its new owner task ID. -->

<!-- Optional but recommended when tasks repeat the same shape: -->
## Task template (applies to every task below)

1. **Inventory:** read the target + grep its usages/consumers.
2. **Change:** <the wave's standard transformation, stated once>.
3. **Verify:** <the wave's standard per-task check>.
4. **Commit:** `<type>(<scope>): <ID> — <what>`.

Per-task notes below are the *deltas* from this template.

---

### Task <ID1> — <name>

**Covers:** <ID> (<size S/M/L>) · depends <IDs or —>

**Files:**
- Create: `<exact/path>`
- Modify: `<exact/path>` (<line anchor if known>)

**Spec:** <exact values / state tables with source-section references; add a provenance note
for any value the spec does NOT state explicitly>

**Steps:**
1. <one 2–5-minute action>
2. <…>
3. Verify: <exact command + expected result>
4. Commit: `<type>(<scope>): <ID> — <what>`

---

### Task W<N>-GATE — Wave verification gate

1. <build command> exits 0 <on the pinned toolchain from the Reality baseline>.
2. <the test rungs the capability baseline says are runnable> — <what must stay green; how to handle
   intended snapshot/golden churn: eyeball diffs, then re-baseline; commit baselines separately>.
   Unrunnable rungs: execute the degraded form <build + targeted greps + read-only reviewer agents>
   and record "not verified in-session" in the status line — never claim them.
3. Fresh-context audit — run <audit workflow/skill> with **exact valid args**: `<invocation>`
   <or standalone read-only reviewer agent(s) if workflows need an opt-in the session lacks>.
   Scope: this wave's surface **plus the shared/global files it touched**.
4. Triage findings: fix in-scope high/medium (+ cheap nits) now; re-home every deferral onto a
   **named later task** (usually the QA wave) and record it in this file's gate status line.
5. Commit remediation (if anything was fixed): `fix(<scope>): W<N> gate — remediate audit findings`.
6. Testing summary: write/refresh `docs/<effort>-summary/wave-<N>-<theme>.md` — *what changed ·
   how to verify · what is intentionally NOT changed yet* — and add/tick its row in that folder's
   index README.
7. Update: this file's Status section → all `[x]` with commit hashes + deviations; README rollup row
   (outcome · env caveats · deferrals); <external checklist tooling reads, if any>.
8. Commit: `docs(<scope>): W<N> gate — <theme> complete`.
9. **Context checkpoint:** stop here — end the turn and announce that Wave <N> is complete and
   committed, so this is a lossless point to `/compact` or `/clear` (all state the next wave needs
   is on disk: this Status section, the README rollup, git history). Don't start Wave <N+1> in the
   same turn; a fresh or compacted context resumes via README → [Wave <N+1>](wave-<N+1>-<theme>.md).

**Wave <N> done when:** <IDs> `[x]`, gate passed. → [Wave <N+1>](wave-<N+1>-<theme>.md).
```

---

## Template 4 — `design-<feature>.md` (optional — a feature design document)

<!-- Add a design document when a FEATURE inside the plan is complex enough that its "how" needs to
     be settled BEFORE the wave's task steps: non-trivial control flow, interacting components,
     concrete interfaces/data models, or correctness properties worth property-testing. It sits
     between the requirements/backlog (the *what/why*) and the wave file (*how to build it, task by
     task*) — the middle "design" layer of a requirements → design → tasks flow.

     NOT the same artifact as ARCHITECTURE.md (Template 3). Keep them distinct:
       • ARCHITECTURE.md — ONE per plan; the PROGRAM-WIDE system shape (C4 views, ADRs, module
         layout, wave↔architecture coverage). Spans all waves.
       • design-<feature>.md — ZERO OR MORE per plan; how ONE feature/component works. Scoped to the
         wave(s) that build it. A plan can have several.

     Precedence: when ARCHITECTURE.md also exists, a design doc works WITHIN its principles and
     ADRs and adds only feature-local decisions — on any conflict ARCHITECTURE.md wins; amend its
     ADR with a dated note BEFORE diverging. Never describe the same flow or record the same
     decision in both artifacts: ARCHITECTURE links here for the mechanism.

     Placement & naming: in the plan folder, named `design-<feature>.md`. Wire it: the wave file that
     builds the feature links to it via a **Design:** header line (verify-plan.py FAILS any design doc
     that no non-design plan file links, directly or via its spine — just like an unwired
     ARCHITECTURE.md). Traceability: every Correctness Property cites the backlog/requirement IDs it
     validates (`**Validates: M4, M5**`), the same IDs the wave's task headings use.

     Diagrams are MERMAID per references/mermaid.md (safe-character labels, `sequenceDiagram`/
     `graph TD` only, no hex `style`) — never ASCII.

     Scale & split: a small feature keeps everything in ONE `design-<feature>.md`. When Components or
     Correctness grow long, split them into sibling files `design-<feature>-components.md` and
     `design-<feature>-correctness.md`, each starting with a "Part of the [<feature> Design](...)"
     backlink and linked from the spine's **Related documents** list. Filled-in (split) example:
     exemplar-design.md (this folder). -->

```markdown
# Design: <Feature Name>

<!-- Related documents — include only if you split Components/Correctness into sibling files: -->
**Related documents:**
- [Components & Interfaces](./design-<feature>-components.md)
- [Data Models & Correctness Properties](./design-<feature>-correctness.md)

## Overview
<!-- 2–5 sentences: what the feature does and the core mechanism. Name the wave that delivers it
     and the backlog/requirement rows it covers. -->

## Architecture
<!-- A Mermaid `sequenceDiagram` (or `graph TD`) of the critical path, obeying references/mermaid.md. -->

## Key Design Decisions
<!-- Bullets, each stating the decision AND its consequence/trade-off. These are the choices a
     reviewer cites. If a decision rejects a real alternative and belongs to the whole program, it's
     an ADR in ARCHITECTURE.md instead — keep feature-local decisions here. -->

## Error Handling
<!-- Table: Failure → Behaviour. One row per failure mode the design must survive. -->
| Failure | Behaviour |
|---|---|
| <failure mode> | <retry/log/skip behaviour> |

## Components & Interfaces
<!-- Split to design-<feature>-components.md when long. Contains: File Layout (a small tree of the
     files this feature adds/touches); Public API (exact exported signatures with a doc-comment
     contract); Internal flow (numbered steps); Integration point (where/how existing code calls in). -->

## Data Models
<!-- The types/interfaces and any stored-state key/table shapes (pattern · value · TTL/lifecycle). -->

## Correctness Properties
<!-- Split to design-<feature>-correctness.md when long. Each property is a *universal* statement
     ("For any …") + the backlog/requirement IDs it validates. Prefer a few properties that each
     carry unique value; add a short Property Reflection noting overlaps removed. -->
### Property 1: <name>
*For any* <inputs/state>, <what must hold>. **Validates: <IDs>**

## Testing Strategy
<!-- Unit tests (bullets), property-based tests (tool + min runs, pointing at Correctness Properties),
     and integration tests. This is the contract the wave's test task and gate implement. -->
```
