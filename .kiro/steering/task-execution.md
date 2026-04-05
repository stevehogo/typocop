---
inclusion: fileMatch
fileMatchPattern: "src/**"
---

# Task Execution Workflow

## Activating Skills Before Task Execution

Every task in the spec may define a `_Skills` list. Before executing any task, activate each listed skill using the `discloseContext` tool. This loads the skill's full guidance into context so it influences the implementation.

### Rule

When a task contains a `_Skills` field, call `discloseContext` for **each skill** before delegating or implementing the task.

```
_Skills: `testing-patterns`, `tdd-workflow`
```

→ Call `discloseContext("testing-patterns")` and `discloseContext("tdd-workflow")` first.

### Why

Skills contain detailed workflow guidance, patterns, and anti-patterns that directly shape how the task should be implemented. Skipping this step means the implementation proceeds without that context, potentially missing important conventions.

### Order of Operations

1. Read the task details from the spec
2. Identify all `_Skills` listed
3. Activate each skill via `discloseContext`
4. Then delegate to the subagent or begin implementation

This applies to all task types: implementation tasks, test-writing tasks, and refactoring tasks.
