---
name: kiro-spec-executor
description: "Task execution protocol for Kiro spec-driven development. Use when executing work from `.kiro/specs/*/tasks.md` or linked `tasks-*.md` files: read the relevant task list, load only the design and requirements files needed for the selected task, activate any `_Skills`, implement the scoped work, verify it, update task checkboxes, and report clearly."
---

# Kiro Spec Executor

Use this skill when the user asks to execute a task, continue a spec, work through a phase, or resume partially completed work under `.kiro/specs/`.

## Trigger Conditions

Apply this skill when any of these are true:

- the user mentions a Kiro spec, `.kiro/specs/`, `requirements.md`, `design.md`, or `tasks.md`
- the task is clearly driven by a spec package in `.kiro/specs/<spec-name>/`
- the user wants implementation to follow Kiro requirements/design/tasks rather than ad hoc coding

## Core Rules

1. Treat the spec as the source of truth:
   - `requirements*.md` defines behavior.
   - `design*.md` defines architecture, contracts, and constraints.
   - `tasks*.md` defines execution order and scope.
2. Read only the files needed for the current task. Do not bulk-load every spec file.
3. Activate every skill named in `_Skills` before implementing.
4. Do not mark a task complete until the relevant verification passes.
5. Do not silently expand scope. If the spec is inconsistent or missing critical detail, stop and surface the gap.

## Execution Workflow

### 1. Identify the active task file

Start from the feature's main task index:

```text
.kiro/specs/{feature}/tasks.md
```

From there:

- Find the specific task the user requested, or the next incomplete task if they asked to continue.
- Follow links to sibling task files such as `tasks-client.md`, `tasks-testing.md`, or `tasks-02-indexing.md` when the work is split across files.
- Read only the task file that contains the task you are executing, plus the root `tasks.md` if it provides ordering or phase context.

### 2. Parse task metadata

For the selected task, capture:

- Task number and title
- Child subtasks
- `_Skills`
- `_Requirements`
- Whether the task is a checkpoint
- Whether the task is optional (`- [ ]*`)

Interpret checkboxes as:

- `- [ ]` not started
- `- [-]` in progress
- `- [~]` queued/deferred
- `- [x]` complete

Optional tasks are executed only if the user explicitly asked for them.

### 3. Read the minimum supporting spec files

Always read:

- `design.md`
- `requirements.md`

Then read only the sub-files needed by the task. Common mappings:

| Task content | Read |
| --- | --- |
| Domain model, types, config, schemas | `design-data-models.md`, `design-schemas.md`, or equivalent linked design file |
| Services, runtime flow, business logic | `design-services.md` or the relevant design section/file |
| API, transport, RPC, routes | `design-api.md` or transport-specific design file |
| Correctness rules, invariants, properties | `design-correctness.md` |
| Architecture or phased rollout | `design.md` and any linked architecture sub-file |

Also read any `requirements-*.md` files that define the referenced requirement IDs.

If the repo contains always-on project rules under `.agents/rules/`, obey them alongside the spec.

### 4. Activate referenced skills

For each skill listed in `_Skills`:

- Open its `SKILL.md`
- Read only enough to apply its workflow
- Use the minimal set of referenced materials needed for the task

Do not pretend a skill was used without reading it.

### 5. Execute the task

Work through the selected task and its subtasks in order.

Implementation expectations:

- Match exact file paths, names, interfaces, and constraints from the design docs.
- Prefer minimal edits that satisfy the task cleanly.
- Do not refactor unrelated code unless required to complete the task safely.
- Preserve existing user changes outside the task scope.
- If a task is phrased as a checkpoint, perform verification for the preceding implementation work instead of inventing new code.

For Codex specifically:

- Prefer `rg`/`rg --files` for discovery.
- Use `apply_patch` for manual file edits.
- Verify using the smallest command set that proves the task is correct.
- If verification is blocked by the environment, report the exact blocker and leave the task unchecked unless the user explicitly wants a documentation-only update.

### 6. Verify before completion

Run the verification that matches the task. Examples:

- Targeted unit/integration tests
- TypeScript compile check
- Lint for touched files
- Build or package command when the task affects shipped artifacts

Verification should be proportional:

- Prefer focused tests for the changed area first.
- Run broader checks when the task or repo conventions require them.
- For checkpoint tasks, verification is the main output.

If verification fails:

- Fix the issue if it is within scope.
- Do not mark the task complete while failures remain.

### 7. Update task status

After successful implementation and verification:

1. Mark completed subtasks from `- [ ]` to `- [x]`.
2. Mark the parent task `- [x]` when all of its required subtasks are complete.
3. Preserve `_Skills`, `_Requirements`, and surrounding formatting.

Use `- [-]` only when you are intentionally leaving the task mid-flight in a saved in-progress state.

## Checkpoint Handling

Checkpoint tasks usually mean "verify the previous phase" rather than "write more code."

When a checkpoint appears:

1. Read the checkpoint text carefully.
2. Run the verification it calls for.
3. Ask the user only if the checkpoint explicitly requires input or you hit a real blocker.
4. Mark it complete only if the checkpoint conditions were actually verified.

## Reporting Format

When you finish, report briefly with:

- The task number and title
- What changed
- What was verified
- Any remaining risk or follow-up

Example:

```text
Task 8.1 complete: Create src/db/autostart.ts implementing AutostartManager

Changed:
- added cross-process autostart flow with lock, discovery, and readiness polling
- wired typed startup and availability failures to the documented error classes

Verified:
- pnpm test -- src/db/autostart.test.ts
- npx tsc --noEmit

Requirements:
- 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
```

## Failure Modes To Avoid

- Implementing from the task title without reading the design files
- Skipping `_Skills`
- Editing beyond the selected task scope
- Marking `[x]` before verification
- Loading every spec file when only one design sub-file is needed
- Treating checkpoint tasks like feature tasks
- Continuing into the next phase without the user asking to continue

## When This Skill Applies

Use this skill when the request is any of:

- "execute task 4.2"
- "continue this spec"
- "work through phase 3"
- "finish the next unchecked Kiro task"
- "resume the tasks in `.kiro/specs/...`"
