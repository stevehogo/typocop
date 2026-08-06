# Optional artifacts: `ARCHITECTURE.md` and `design-<feature>.md`

Two optional documents can sit in the plan folder alongside `README.md` and the wave files.
Most plans need neither. Decide in Step 2; write them in Step 3 from Templates 3 and 4 in
[`templates.md`](templates.md).

## Which one, if either?

|  | `ARCHITECTURE.md` | `design-<feature>.md` |
|---|---|---|
| **Answers** | how the system is *shaped* and why it holds | how *one feature* works |
| **Scope** | program-wide, spans all waves | one feature, scoped to the wave that builds it |
| **How many** | zero or one per plan | zero or more per plan |
| **Add when** | the effort **builds or reshapes a system** — new services/apps, data stores/schemas, transports, trust boundaries, a new module/folder layout | a feature's **how** must be settled before its task steps — non-trivial control flow, interacting components with concrete interfaces/data models, or invariants worth property-testing |
| **Skip when** | the effort transforms *within* an existing architecture (restyles, content/value migrations) — the README's **Architecture:** paragraph carries those | straightforward CRUD/config waves |
| **Template** | Template 3 | Template 4 |
| **Filled example** | [`exemplar-architecture.md`](exemplar-architecture.md) | [`exemplar-design.md`](exemplar-design.md) |

Litmus test for `ARCHITECTURE.md`: if you find yourself writing rejected-alternatives and
dependency rules just to justify the README's Architecture blurb, promote them to the file.

---

## `ARCHITECTURE.md`

Records the *shape of the system and why it holds that shape*.

### What it contains

- **Load-bearing principles** — each stated with its *Consequence*. These are what reviewers cite.
- **C4-style views** (context / containers / components) **+ the dependency rule** stated in prose:
  the arrows show what may import what, the sentence enforces it.
- **A canonical module layout** — see below.
- **Data architecture** — stores and roles, entities grouped by lifecycle, derived-not-stored rules.
- **Runtime flows** — one per critical path, each naming the wave that delivers it.
- **Security & trust boundaries**, cross-cutting concerns, deployment.
- **ADRs** — *context → decision → rejected alternatives → consequences*. Amendments and
  supersessions are **dated notes on the original**, never rewrites: history is not edited.
- **A build-sequence ↔ architecture coverage table** — the contract with the wave files. Re-cutting
  waves means updating it.
- **Second-order risks** with the seam to pull if each one bites.

### Canonical module layout

Design this section with the `clean-code` and `senior-architect` skills loaded if they exist in the
environment; if they don't, apply the defaults below directly.

Default to a **feature-first + layered-inside** axis (feature folders on top, `ports/` kept apart
from `adapters/` inside each, a `shared/` kernel, one composition root where concretes are
injected). The organising axis is a real decision — record it as an ADR. Right-size it: don't spawn
single-file layer folders for a small effort.

Whichever axis you pick, group the tree so the dependency rule is **visible in it**, and close with
a short *module conventions* list: import-specifier style, type-only imports, no barrel/re-export
hubs, ports-vs-adapters, validation at the boundary, errors as values.

### Hard rules

1. **It introduces no new decisions.** Every choice traces to the spec/decisions source. The file
   only *consolidates* scattered facts and *surfaces* second-order consequences.
2. **Diagrams are Mermaid, never ASCII.** Every C4 view and runtime flow is a ` ```mermaid ` fenced
   block obeying [`mermaid.md`](mermaid.md) — a compatibility ruleset, not a suggestion — so the
   diagrams render identically in VS Code, GitHub, and Kiro.
3. **Wire it.** The README's **Architecture:** line links to it. `verify-plan.mjs` fails an unwired
   `ARCHITECTURE.md`. Keep its Status line current at wave gates.

---

## `design-<feature>.md`

The *design* layer between the requirements/backlog (**what** and **why**) and the wave file
(**how to build it, task by task**).

### What it contains

- **Overview** — the mechanism, the delivering wave, the backlog rows covered.
- **Architecture** — a Mermaid flow obeying [`mermaid.md`](mermaid.md).
- **Key Design Decisions** — each with its consequence or trade-off.
- **Error Handling** — a failure → behaviour table, one row per failure mode.
- **Components & Interfaces** — file layout, exact exported signatures, internal flow, and the
  integration point where existing code calls in.
- **Data Models** — types and any stored-state key/table shapes.
- **Correctness Properties** — universal *"for any …"* statements, each citing the
  backlog/requirement IDs it validates: the same IDs the wave's task headings use.
- **Testing Strategy** — the contract the wave's test task and gate implement.

### Precedence against `ARCHITECTURE.md`

A design doc works **within** `ARCHITECTURE.md`'s principles and ADRs and adds only feature-local
decisions. On any conflict `ARCHITECTURE.md` wins — amend its ADR with a dated note *before*
diverging.

Never record the same decision or draw the same flow in both: `ARCHITECTURE.md`'s runtime-flow
section stays program-level and **links** the design doc for the mechanism. Duplicated content
drifts.

### Splitting and wiring

- Split long ones into siblings `design-<feature>-components.md` and
  `design-<feature>-correctness.md`, each opening with a backlink to the spine and listed in the
  spine's *Related documents*.
- **Wire it:** the wave file that builds the feature links to it via a **Design:** header line.
  `verify-plan.mjs` fails any `design*.md` that no non-design plan file links, directly or via its
  spine — orphan docs and self-referential clusters both fail.
