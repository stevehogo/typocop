# Execution Plan: Tasks 16–22 — Query Server & Query Types

Source: [tasks-04-query-server.md](../specs/code-graph-analyzer/tasks-04-query-server.md)

---

## Dependency Analysis

### Core dependency chain

```
16.1 (intent classification)
  └─► 16.2 (query execution engine)   ← needs intent to route queries
        └─► 16.3 (result formatting)  ← needs execution output to format
              └─► 16.4* (property tests for query execution)
```

### Query type handlers — depend on 16.1 + 16.2

All five query type tasks (17.1, 18.1, 19.1, 20.1, 21.1) are **routed through the execution engine** (16.2) and share the same `QueryResult` shape formatted by 16.3. They cannot be meaningfully integrated until 16.1–16.3 are done, but their **internal logic is independent of each other**.

```
16.1 + 16.2 + 16.3 complete
  └─► 17.1, 18.1, 19.1, 20.1, 21.1  (all parallel)
        ├─► 17.2* (risk level test)   depends on 17.1
        └─► 21.2* (tracing test)      depends on 21.1
```

### Checkpoint

```
22 depends on ALL tasks above being complete
```

---

## Execution Waves

### Wave 1 — Foundation (sequential, no parallelism possible)

| Step | Task | Reason |
|------|------|--------|
| 1a | **16.1** — Query intent classification | Entry point; everything routes through intent |
| 1b | **16.2** — Query execution engine | Needs intent from 16.1 to dispatch correctly |
| 1c | **16.3** — Result formatting | Needs execution output shape from 16.2 |

These three must run in order. No shortcuts.

---

### Wave 2 — Query type handlers (fully parallel)

All five can start simultaneously once Wave 1 is done. They share no state with each other.

| Task | What it does | Graph ops used |
|------|-------------|----------------|
| **17.1** — Impact analysis | Transitive dependents + risk level | `findDependents` (graph traversal) |
| **18.1** — Smart search | Semantic search → cluster grouping | `semanticSearch` + cluster lookup |
| **19.1** — Pre-commit check | Changed files → blast radius | `findDependents` (same as 17.1, different entry) |
| **20.1** — Context retrieval | 360° callers/callees/clusters/processes | `findDependents` + `findDependencies` |
| **21.1** — Data flow tracing | API → controller → service → repo → DB | call graph traversal, framework-aware |

> Note: 17.1 and 19.1 both use graph traversal for dependents but are independent implementations — they can still run in parallel.

---

### Wave 3 — Property tests (parallel, after their respective impl)

Optional tasks (`*`) — run after their implementation task completes.

| Task | Depends on | Properties covered |
|------|-----------|-------------------|
| **16.4*** — Query execution tests | 16.2 + 16.3 (Wave 1 done) | P9: result limit, P10: confidence bounds, P11: high-confidence completeness |
| **17.2*** — Risk level consistency | 17.1 | P12: risk level thresholds |
| **21.2*** — Framework tracing tests | 21.1 | P16: full tracing completeness, P17: partial tracing |

16.4 can start as soon as Wave 1 finishes, in parallel with Wave 2.

---

### Wave 4 — Checkpoint

| Task | Depends on |
|------|-----------|
| **22** — All tests pass | Everything above |

---

## Visual Timeline

```
Wave 1 (sequential)          Wave 2 (parallel)           Wave 3 (parallel)    Wave 4
─────────────────────────    ────────────────────────    ─────────────────    ──────
16.1 → 16.2 → 16.3           17.1 ──────────────────►   17.2*
                              18.1                                             22
                              19.1                        16.4*
                              20.1
                              21.1 ──────────────────►   21.2*
```

---

## Parallelism Summary

| Wave | Tasks | Can run in parallel? |
|------|-------|---------------------|
| 1 | 16.1 → 16.2 → 16.3 | No — strictly sequential |
| 2 | 17.1, 18.1, 19.1, 20.1, 21.1 | Yes — all 5 in parallel |
| 3 | 16.4*, 17.2*, 21.2* | Yes — each after its own impl |
| 4 | 22 | No — gate on everything |

Maximum parallelism is achieved in Wave 2: **5 tasks simultaneously**.

---

## Notes

- Tasks marked `*` are optional property tests. They should be executed if time allows but are not blockers for Wave 4 unless the team wants full PBT coverage before shipping.
- 17.1 and 19.1 share the `findDependents` graph operation — coordinate to avoid duplicating that utility if it doesn't already exist in `src/graph/`.
- 18.1 depends on the semantic search layer from tasks-03 (Phase 6 search index) being available. Confirm that is complete before starting Wave 2.
