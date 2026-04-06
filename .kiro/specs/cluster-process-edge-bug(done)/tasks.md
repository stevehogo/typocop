# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Reversed Edge Direction and Wrong RelType
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the wrong `relType` and reversed `source`/`target`
  - **Scoped PBT Approach**: Scope to concrete failing cases — a cluster with ≥1 symbol and a process with ≥1 step
  - Test file: `src/indexer/pipeline.test.ts` (create if absent), using `vitest` + `fast-check`
  - Mock `storeNodes` and `storeEdges` via `vi.mock` to capture emitted edges without a real Neo4j session
  - Use `fc.assert(fc.property(clusterArbitrary, processArbitrary, ...))` scoped to non-empty inputs
  - Assert cluster edges: `edge.relType === "CONTAINS"` and `edge.source === cluster.id` (FAILS — actual is `"BELONGS_TO"` / symbolId)
  - Assert process edges: `edge.relType === "HAS_STEP"` and `edge.source === process.id` (FAILS — actual is `"PART_OF"` / symbolId)
  - Run: `pnpm vitest --run src/indexer/pipeline.test.ts`
  - **EXPECTED OUTCOME**: Test FAILS — document counterexamples (e.g. `edge.relType = "BELONGS_TO"`, `edge.source = "UserService.login"`)
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Relationship Edges and Node Writes Are Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - Observe: on unfixed code, `relationshipEdges` (CALLS, IMPORTS, INHERITS, etc.) are stored with their original `source`, `target`, `relType`
  - Observe: cluster/process nodes are stored with correct properties (`name`, `category`, `confidence`, `stepCount`, etc.)
  - Observe: `order` property on process step edges equals `String(step.order)`
  - Write property-based test: for all `Relationship[]` inputs, emitted relationship edges match exactly — `source`, `target`, `relType` unchanged
  - Write property-based test: for empty `clusters` and `processes` arrays, no cluster or process edges are emitted
  - Write property-based test: for any process with steps, each emitted edge has `properties.order === String(step.order)`
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS — confirms baseline behavior to preserve
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.5_

- [x] 3. Fix reversed cluster and process edges in `buildGraph`

  - [x] 3.1 Implement the fix in `src/indexer/pipeline.ts`
    - In `clusterEdges`: change `source: symbolId, target: c.id, relType: "BELONGS_TO"` → `source: c.id, target: symbolId, relType: "CONTAINS"`
    - In `processEdges`: change `source: step.symbolId, target: p.id, relType: "PART_OF"` → `source: p.id, target: step.symbolId, relType: "HAS_STEP"`
    - No other lines in the file change
    - _Bug_Condition: isBugCondition(edge) where edge.relType is "BELONGS_TO" or "PART_OF", or source/target are reversed_
    - _Expected_Behavior: cluster edges are (cluster)-[:CONTAINS]->(symbol); process edges are (process)-[:HAS_STEP]->(symbol) with order property_
    - _Preservation: relationshipEdges, node writes, and order property must remain byte-for-byte identical_
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.5_

  - [x] 3.2 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Cluster and Process Edges Have Correct Type and Direction
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - Run: `pnpm vitest --run src/indexer/pipeline.test.ts`
    - **EXPECTED OUTCOME**: Test PASSES — confirms `relType` and `source`/`target` are now correct
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 3.3 Verify preservation tests still pass
    - **Property 2: Preservation** - Relationship Edges and Node Writes Are Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run: `pnpm vitest --run src/indexer/pipeline.test.ts`
    - **EXPECTED OUTCOME**: Tests PASS — confirms no regressions in relationship edges, node writes, or order property
    - _Requirements: 3.1, 3.5_

- [x] 4. Checkpoint — Ensure all tests pass
  - Run full suite: `pnpm vitest --run`
  - Confirm Property 1 (bug condition) and Property 2 (preservation) both pass
  - Ensure no other tests regressed
  - Ask the user if any questions arise
