# Implementation Plan

- [ ] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Process Steps Always Empty
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate `graphNodeToProcess` never queries `HAS_STEP` edges
  - **Scoped PBT Approach**: Scope the property to concrete failing cases — Process nodes with 1–5 `HAS_STEP` edges
  - Create `src/query/process-helpers.test.ts`
  - Mock a Neo4j session that returns `HAS_STEP` edges for a given process ID
  - Import `graphNodeToProcess` from `src/query/context-retrieval.ts` (the current unfixed version)
  - Write property: for any Process node with N steps (N ∈ [1, 5]), `graphNodeToProcess(node).steps.length === N`
  - Also assert steps are ordered ascending by `order`
  - Run test on UNFIXED code: `pnpm vitest --run src/query/process-helpers.test.ts`
  - **EXPECTED OUTCOME**: Test FAILS — `steps` is always `[]` regardless of mocked `HAS_STEP` edges
  - Document counterexample: e.g. "graphNodeToProcess(processNode) returns steps: [] when 3 HAS_STEP edges exist"
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2_

- [ ] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Non-Process Fields Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - Observe: `executeContextRetrieval` returns `symbols`, `clusters`, `confidence`, `riskLevel`, `affectedFlows` on unfixed code
  - Observe: `executeImpactAnalysis` returns identical non-process fields on unfixed code
  - Write property-based tests in `src/query/process-helpers.test.ts` using `fast-check`:
    - For any symbol name input, `symbols` array is identical before/after fix (mock session returns same nodes)
    - For any cluster input, `clusters` array is identical before/after fix
    - For any input resolving to no processes, `processes: []` is returned unchanged
    - `riskLevel` and `confidence` values are identical for the same inputs
  - Verify tests PASS on UNFIXED code: `pnpm vitest --run src/query/process-helpers.test.ts`
  - **EXPECTED OUTCOME**: Tests PASS — confirms baseline non-process behavior to preserve
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [ ] 3. Fix: populate process steps from HAS_STEP edges

  - [ ] 3.1 Add `findProcessSteps` to `src/graph/query.ts`
    - Add new exported async function `findProcessSteps(session: Session, processId: string): Promise<ProcessStep[]>`
    - Cypher: `MATCH (p:Process {id: $processId})-[r:HAS_STEP]->(s) RETURN s.id AS symbolId, r.order AS order, s.name AS description ORDER BY r.order ASC`
    - Map each record to `{ order, symbolId, description }` using `r.get()`
    - Return empty array when no records found (preserves Req 3.1)
    - Import `ProcessStep` from `../types/index.js`
    - _Bug_Condition: isBugCondition(X) = true for all Process nodes — graphNodeToProcess always returns steps: []_
    - _Expected_Behavior: findProcessSteps returns ProcessStep[] ordered by order ASC, length equals HAS_STEP edge count_
    - _Requirements: 2.1_

  - [ ] 3.2 Create `src/query/process-helpers.ts` with shared `graphNodeToProcess`
    - Create new file exporting `graphNodeToProcess(node: GraphNode, session: Session): Promise<Process>`
    - Call `findProcessSteps(session, node.id)` to populate `steps`
    - Map remaining fields from `node.properties` (id, name, entryPoint, dataFlow: [])
    - Also export `graphNodeToCluster(node: GraphNode): Cluster` to consolidate duplication
    - Import `findProcessSteps` from `../graph/query.js`
    - Import `GraphNode` from `../graph/connection.js`
    - Import `Process`, `Cluster`, `ClusterCategory` from `../types/index.js`
    - _Preservation: graphNodeToCluster logic must be identical to the existing copies in all three query files_
    - _Requirements: 2.1, 3.2_

  - [ ] 3.3 Update `src/query/context-retrieval.ts`
    - Remove local `graphNodeToProcess` and `graphNodeToCluster` functions
    - Add import: `import { graphNodeToProcess, graphNodeToCluster } from "./process-helpers.js"`
    - Update process mapping: `processNodes.map(graphNodeToProcess)` → `await Promise.all(processNodes.map(n => graphNodeToProcess(n, graphSession)))`
    - Update cluster mapping to use imported `graphNodeToCluster`
    - All other logic (findDependents, findDependencies, confidence, riskLevel, affectedFlows) remains unchanged
    - _Preservation: symbols, relationships, clusters, confidence, riskLevel, affectedFlows must be identical_
    - _Requirements: 2.1, 3.2, 3.3_

  - [ ] 3.4 Update `src/query/impact-analysis.ts`
    - Remove local `graphNodeToProcess` and `graphNodeToCluster` functions
    - Add import: `import { graphNodeToProcess, graphNodeToCluster } from "./process-helpers.js"`
    - Update process mapping: `processNodes.map(graphNodeToProcess)` → `await Promise.all(processNodes.map(n => graphNodeToProcess(n, graphSession)))`
    - Update cluster mapping to use imported `graphNodeToCluster`
    - All other logic (findDependents, calculateImpactRisk, confidence, riskLevel, affectedFlows) remains unchanged
    - _Preservation: symbols, relationships, clusters, confidence, riskLevel, affectedFlows must be identical_
    - _Requirements: 2.1, 3.2, 3.3_

  - [ ] 3.5 Update `src/query/pre-commit-check.ts`
    - Remove local `graphNodeToProcess` and `graphNodeToCluster` functions
    - Add import: `import { graphNodeToProcess, graphNodeToCluster } from "./process-helpers.js"`
    - Update process mapping: `allProcessNodes.map(graphNodeToProcess)` → `await Promise.all(allProcessNodes.map(n => graphNodeToProcess(n, graphSession)))`
    - Update cluster mapping to use imported `graphNodeToCluster`
    - All other logic (findSymbolsInFiles, findDependents, calculatePreCommitRisk, affectedFlows) remains unchanged
    - _Preservation: symbols, relationships, clusters, confidence, riskLevel, affectedFlows must be identical_
    - _Requirements: 2.1, 3.2, 3.3_

  - [ ] 3.6 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Process Steps Populated from HAS_STEP Edges
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 encodes the expected behavior: `steps.length === N` for N HAS_STEP edges
    - Run: `pnpm vitest --run src/query/process-helpers.test.ts`
    - **EXPECTED OUTCOME**: Test PASSES — confirms `graphNodeToProcess` now queries `findProcessSteps`
    - _Requirements: 2.1, 2.2, 2.3_

  - [ ] 3.7 Verify preservation tests still pass
    - **Property 2: Preservation** - Non-Process Fields Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run: `pnpm vitest --run src/query/process-helpers.test.ts`
    - **EXPECTED OUTCOME**: Tests PASS — confirms no regressions in symbols, clusters, confidence, riskLevel, affectedFlows
    - Confirm `smart-search.ts` is untouched (it fetches steps via `p.steps` node property — different mechanism)

- [ ] 4. Checkpoint — ensure all tests pass
  - Run full test suite: `pnpm vitest --run --reporter=basic`
  - Ensure all tests pass, ask the user if questions arise
  - Confirm `src/query/smart-search.ts` was not modified
  - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4_
