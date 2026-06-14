# LadybugDB Indexing Performance and Progress Plan

Date: 2026-06-14
Last reconciled with working tree: 2026-06-14

Supersedes: `docs/plans/2026-06-13-indexer-performance-plan.md` for the
LadybugDB persistence and ingestion portions only. The older plan (all 11 PRs
landed in the working tree, uncommitted) remains the broader parse/search
pipeline roadmap.

## Scope

This plan targets the slow part users perceive as "indexing into LadybugDB":
turning already-built symbols, relationships, clusters, processes, and
embeddings into persisted graph/vector rows through embedded LadybugDB or the
remote Ladybug connection server.

Current pipeline shape (file anchors so this plan stays actionable):

1. Phases 1–5 build in-memory index data — `src/application/indexing/pipeline.ts`.
2. Phase 6 builds the search index and embeddings — `buildSearchIndex` in
   `src/application/indexing/search/`.
3. The `persist` phase writes vectors then graph nodes/edges through the
   batch-or-fallback helpers in
   `src/application/indexing/persistence-helpers.ts`.
4. Metrics are collected in `src/application/indexing/metrics.ts`.
5. Progress is rendered by `src/platform/logging/progress.ts`.
6. Batch caps and the gRPC payload budget live in
   `src/platform/utils/limits.ts`.

## Reconciliation: what is already in the tree (read this first)

The original draft of this plan listed Phase A as the only remaining gap and
recommended shipping it "immediately." That work has since landed. Re-grade
against the code before starting anything below — several phases are partly or
fully done.

| Plan phase | Status in tree | Evidence |
| --- | --- | --- |
| **A — persistence progress** | **DONE** | `pipeline.ts:205-247` builds `createProgressRenderer({ verbose, label: "Indexing into LadybugDB" })`, computes `countPersistRows(...)` (vectors + nodes + rel edges + CONTAINS + HAS_STEP), and drives it via `advancePersistProgress` off the `onRows` callbacks of `writeVectorEntries` / `writeNodeGroup` / `writeRelationshipGroup`. `progress.ts` already does stderr-only, TTY-throttled animation and non-TTY verbose-gated lines. |
| **B — batch-level metrics** | **PARTIAL** | `metrics.ts` counts ROWS (`graphNodeWrites`, `graphEdgeWrites`, `vectorWrites`) but has no batch/split/oversized counters. Adaptive-split and oversized-row events only reach `console.warn` in `persistence-helpers.ts` — uncounted, so a "many tiny retries" run is invisible in metrics. |
| **C — per-entity batch caps** | **STRUCTURE DONE, TUNING NOT** | `limits.ts` already splits caps: `DB_NODE_WRITE_BATCH_SIZE=250`, `DB_VECTOR_WRITE_BATCH_SIZE=200`, `DB_RELATIONSHIP_WRITE_BATCH_SIZE=DB_WRITE_BATCH_SIZE=500`, with a single byte budget `getRpcPayloadBudgetBytes()` = 0.75 × gRPC limit. Values are guesses, not evidence-derived. |
| **D — reduce graph write volume** | **MEASUREMENT DONE, SEMANTIC CHANGE NOT** | `dependsOnStats` (`edgeCount`, `maxFanOutPerImport`) is computed in Phase 3 and logged at `pipeline.ts:150`. No edge-shape change has been made. |
| **E — benchmark harness** | **NOT DONE** | No ingestion benchmark fixture/runner exists. |

Net: **the headline deliverable is already shipped.** The real remaining work is
B (make slow runs explain themselves), then evidence-driven C, then E, then D
only if E/D measurements justify a semantic change.

## Bottlenecks to Measure First

Use verbose pipeline metrics (`formatMetrics` in `metrics.ts`) to rank the hot
path before changing storage semantics:

- `metrics.phases.persist` versus `search` and `parsing`,
- `graphNodeWrites`, `graphEdgeWrites`, `vectorWrites`,
- batch count and payload-size distribution (gap — added in Phase B),
- embedded mode versus remote connection-server mode,
- write amplification from `DEPENDS_ON`, `CONTAINS`, and `HAS_STEP` edges
  (`dependsOnStats` already exposes DEPENDS_ON fan-out).

Known measurement caveats to fix or account for (carried from the predecessor
plan):

- `totalLines` is never wired, so the `formatMetrics` LOC/s line never renders on
  real runs. Either wire it in Phase B or drop the line.
- `embeddingElapsedMs` is coarse — it attributes the **entire** Phase 6 `search`
  wall-clock (`pipeline.ts:185-187`), including keyword indexing, to embeddings.
  Treat it as an upper bound, not a true embedding cost, until refined.

Do not optimize by firing unbounded writes in parallel. LadybugDB is an embedded
storage engine behind these adapters, and the remote server already serializes
work through a scheduler (`src/apps/ladybug-server/scheduler.ts`). Batch size,
payload size, and transaction shape are safer first levers than write
concurrency.

## Adapter constraints that bound any change (do not regress these)

These are hard-won invariants from the PR8/PR9 batch implementation. Any Phase
C/D edit that touches write shape must preserve them:

- **Kùzu relationship batches need a `WHERE` join, not struct-field property
  maps.** The embedded `createRelationships` must `MATCH (a),(b) WHERE a.id =
  rel.fromId AND b.id = rel.toId` inside the `UNWIND`; accessing struct fields
  in an inline node-pattern property map throws `unordered_map::at`.
- **Vector metadata is single-encoded.** `JSON.stringify(metadata)` passed as a
  bound param equals the per-row literal — do not double-stringify.
- **`RESOURCE_EXHAUSTED` (gRPC code 8) drives adaptive split.** `writeWithAdaptiveSplit`
  halves and retries; a single oversized row that still fails throws a clear
  "single row exceeds the configured gRPC message limit" error. Phase C must keep
  this fallback working when caps change.
- **Real-Kùzu integration tests are flaky on teardown** ("Timeout terminating
  forks worker" on `connection-server.*.integration.test.ts`). This is a
  pre-existing native-teardown issue, not a regression — verify suspect runs in
  isolation before blaming a change.

## Improvement Plan

### Phase A: Show LadybugDB persistence progress — ✅ DONE

Already implemented (`pipeline.ts:205-247`, `progress.ts`). Acceptance criteria
below are satisfied; listed for regression awareness, not as open work.

- interactive CLI shows a progress bar while rows are written,
- redirected/CI output has no ANSI codes and stays quiet unless `verbose`,
- stdout is untouched (renderer targets `process.stderr` only),
- progress reaches 100% when all vector + graph rows are persisted,
- metrics stay row-accurate on both batch and fallback paths.

Remaining nit (fold into Phase B): the persist progress total is computed by
`countPersistRows`, which independently re-derives node/edge counts. If a future
edit changes what `storeInDatabases` writes (e.g. Phase D), `countPersistRows`
must change in lockstep or the bar will stop short of / overshoot 100%. Add a
test that asserts `sum(onRows) === countPersistRows(...)` for a representative
fixture so the two cannot silently drift.

### Phase B: Make persistence metrics explain slow runs — NEXT

Extend `IndexingMetrics` (and `formatMetrics`) with batch-level counters that are
currently lost to `console.warn`:

- `vectorBatchCount`, `nodeBatchCount`, `relationshipBatchCount`
  (count batch calls, distinct from existing row counts),
- `adaptiveSplitCount` (increment in `writeWithAdaptiveSplit` on each split),
- `oversizedRowCount` (increment in the `chunkBatchPayload` `onOversizedItem`
  hook).

Optionally break node/relationship batch counts down by label/type, but a flat
count per entity class is enough to answer "is time dominated by embeddings,
nodes, edges, vectors, or repeated split retries?".

Implementation notes:

- Thread the collector (or small callback closures) from `pipeline.ts` into the
  `persistence-helpers.ts` write functions so the helpers can report
  batch/split/oversized events without importing the metrics module (keep the
  helpers dependency-light — pass callbacks, mirroring the existing `onRows`
  pattern).
- While here, decide `totalLines`: wire `filesScanned`→line totals during Phase 1
  so the LOC/s line works, or remove the dead branch in `formatMetrics`.

Acceptance criteria:

- a slow run can attribute time to embeddings vs graph nodes vs edges vs vectors
  vs split retries from metrics alone (no log scraping),
- a run that triggers adaptive splits shows a non-zero `adaptiveSplitCount`,
- metrics never include source code or embedding text,
- new counters are covered in `metrics.ts` / `persistence-helpers.test.ts`.

### Phase C: Tune batch defaults from evidence

The per-entity caps already exist; this phase is purely about choosing good
numbers and proving they hold. Use Phase B counters from real slow runs to tune:

- vectors (`DB_VECTOR_WRITE_BATCH_SIZE`, currently 200): payload-dominated; keep
  the count cap small and let the byte budget bind.
- nodes (`DB_NODE_WRITE_BATCH_SIZE`, currently 250): signatures/documentation
  vary heavily — medium cap.
- relationships (`DB_RELATIONSHIP_WRITE_BATCH_SIZE`, currently 500): small rows —
  larger cap is safe.
- keep ONE byte budget derived from the configured gRPC limit
  (`getRpcPayloadBudgetBytes()`), unchanged.

Acceptance criteria:

- no batch request exceeds the configured payload budget (already enforced by
  `chunkByBudget`; assert via a payload-size test, not just trust),
- embedded indexing does not regress from needlessly tiny chunks (compare Phase E
  rows/sec before/after),
- remote indexing avoids gRPC message-size failures without excessive round trips
  (`adaptiveSplitCount` should trend toward 0 at tuned caps),
- adaptive-split fallback and oversized-row handling still work after re-tuning.

### Phase D: Reduce graph write volume where semantics allow

Measurement is already partly in place (`dependsOnStats`). Extend it before
changing anything:

- `DEPENDS_ON` edges per imported package and per file (have `edgeCount` +
  `maxFanOutPerImport`; add per-file if fan-out is the suspect),
- `CONTAINS` edges per cluster,
- `HAS_STEP` edges per process.

If `DEPENDS_ON` fan-out dominates, consider moving dependency edges to file nodes
or synthetic import nodes. That is a semantic change requiring a separate design
note and query regression tests. If `countPersistRows` / `storeInDatabases`
change, update both together (see Phase A nit).

Acceptance criteria:

- existing query behavior stays unchanged unless the semantic change is
  explicitly approved,
- relationship-count reductions are measured before and after (Phase B/E),
- data-flow, impact-analysis, and context-retrieval tests still pass.

### Phase E: Benchmark the end-to-end ingestion path

Add a repeatable benchmark/smoke test that indexes a generated fixture with:

- many small symbols,
- long signatures/documentation (to stress the byte budget and oversized path),
- dense relationships,
- embeddings enabled and disabled,
- embedded and remote adapter variants where feasible (remote runs will hit the
  known native-teardown flake — run them isolated, see constraints above).

Acceptance criteria:

- the benchmark reports total time, persistence time, rows/sec, batch counts, and
  `adaptiveSplitCount` (consumes Phase B output),
- it is not a hard performance gate unless thresholds prove stable,
- it can reproduce the class of slow LadybugDB indexing runs users report.

## Suggested PR Sequence

1. **Phase B** — batch/split/oversized counters + decide `totalLines`. (Phase A
   is already shipped; the next user-visible win is making slow runs legible.)
2. **Phase E (harness only)** — benchmark fixture + runner that prints Phase B
   metrics, before tuning, to establish a baseline.
3. **Phase C** — tune node/vector/relationship caps against the Phase E baseline.
4. **Phase D** — relationship write-volume changes, only if B/E measurements
   justify the semantic change; ships with its own design note + query tests.

## First Recommendation

Phase A is done — do not re-do it; add the `sum(onRows) === countPersistRows`
drift guard instead. Start on **Phase B**: surface `adaptiveSplitCount`,
`oversizedRowCount`, and per-entity batch counts so the very next slow run a user
reports tells you whether the cost is vector payload size, relationship volume,
remote scheduler throughput, or embedding generation — without guessing. Then
let the Phase E baseline, not intuition, drive any cap retuning in Phase C.
