# Feature-Adoption Implementation Plan

> Companion to [`docs/GRAPH-TOOLS-FEATURE-COMPARISON.md`](../GRAPH-TOOLS-FEATURE-COMPARISON.md).
> Turns every selected feature (foundation #1–#6 + Tiers 1–4) into an implementation-grade
> plan, grounded in typocop's actual code (verified 2026-06-20, branch
> `feature/refactor-code-base`). Five workstreams (A–E), a shared-contracts layer (Part 0)
> they all depend on, a global build order (Part 6), and a risk register (Part 8).

## Goal & scope
Adopt the highest-value features from arbor, codebase-memory-mcp (cbm), and GitNexus —
prioritising the two glaring foundation gaps (no incremental indexing, single-core parsing)
and the flagship agent differentiator (auto-augmenting hook), then the analytics/CI/quality
features. GitNexus (same stack: TS + LadybugDB + tree-sitter + ONNX + MCP) proves every item
is buildable here.

## Workstreams
- **A — Incremental Indexing Core** (foundation #1, parse cache, embedding cache, stable identity, diff persistence)
- **B — Parallel Parsing & Performance** (foundation #2 worker threads, #4 adaptive tuning, #6 streaming eval, bench loop)
- **C — Change-Driven Features** (foundation #5 watch; `detect_changes` MCP tool; git-diff layer)
- **D — Agent-Facing MCP Tools** (auto-augment hook; impact explainability; `trace`; token-budget slicing; `rename`; dead-code)
- **E — Resolution Depth, Analytics & RFCs** (deeper resolution; complexity metrics; API contract drift; + RFC: PDG/taint)

## Status tracking
Verified accurate against the code on 2026-06-20. Tracked in the session task list as #1–#22.
Update the Status column (`pending` / `wip` / `done`) as work lands; keep it in sync with the tasks
and the `feature-adoption-plan-progress` memory.

**Wave 1 (incremental core A1–A5) landed & independently verified 2026-06-20** via the
`incremental-core-wave-A` workflow: full suite 1455 passed / 4 skipped / 0 failed; typecheck,
typecheck:tests, depcruise all clean.

**Wave 2 (parsing/perf B2,B1,B4,B3) landed & independently verified 2026-06-20** via the
`parsing-perf-wave-B` workflow: full suite 1490 passed / 5 skipped / 0 failed; typecheck/
typecheck:tests/depcruise clean (321 modules). worker_threads parallel parsing with a determinism
gate, peak-RSS metric, and gated parse bench; A1–A5 core not regressed.

**Wave 3 (change-driven C1,C2,C3) landed & independently verified 2026-06-20** (resumed run
`wf_a4019d6a-2df`): full suite 1536 passed / 5 skipped / 0 failed; typecheck/typecheck:tests/
depcruise clean (334 modules). Git-diff→changed-symbols layer (`GitPort`), the 6th MCP tool
`detect_changes` (reuses `executePreCommitCheck`), and watch mode (chokidar) on `reindexChangedFiles`;
existing 5 MCP tools intact.

**Wave 4 (agent MCP tools D1,D2,D3,D4,D6,D5) landed & independently verified 2026-06-20** via the
`agent-tools-wave-D` workflow: full suite 1661 passed / 5 skipped / 0 failed; typecheck/typecheck:tests/
depcruise clean (359 modules). Flagship auto-augment hook (`hooks/claude/*.cjs` + `augment.ts` + `setup`),
impact explainability (node-role/entry-edge), 3 new MCP tools (`trace`, `rename`, `find_dead_code`),
token-budgeted slicing, and the dead `find_dependents.maxDepth` fix; existing 6 MCP tools intact.

**Wave 5 (resolution/analytics E1,E2,E3) landed & independently verified 2026-06-20** via the
`resolution-analytics-wave-E` workflow (E3's impl agent crashed mid-edit; completed with a one-line
Kùzu `CREATE NODE TABLE` schema fix for `responseKeys`/`accessedKeys`): full suite 1730 passed /
5 skipped / 0 failed; typecheck/typecheck:tests/depcruise clean (385 modules). Deeper resolution
(scope-resolver registry + MRO/C3 additive `overrides`/`methodImplements` edges + chain-binding;
golden resolution tests intact), complexity metrics + `find_hotspots`, and API contract drift
(`shape_check`/`api_impact`). **12 MCP tools total.**

Waves 1–5 (A–E concrete, 21/22 features) committed on `feature/refactor-code-base`. Only E5 (PDG/taint RFC) remains.

| Task | Feature | Status | Blocked by |
|---|---|---|---|
| #1 | A1 — Stable node identity (`logicalKey`) **[KEYSTONE]** | ✅ done | — |
| #2 | A2 — Persisted parse cache | ✅ done | — |
| #3 | A3 — Embedding cache | ✅ done | A1 |
| #4 | A4 — Diff-based persistence | ✅ done | A1 |
| #5 | A5 — Incremental orchestration (`reindexChangedFiles`) | ✅ done | A1–A4 |
| #6 | B2 — Adaptive batch/concurrency tuning | ✅ done | — |
| #7 | B1 — Multi-core parsing via `worker_threads` | ✅ done | B2 |
| #8 | B4 — Benchmark-driven tuning loop | ✅ done | B1 |
| #9 | B3 — Streaming-emit eval + peak-RSS metric | ✅ done | B4 |
| #10 | C1 — Git-diff → changed-symbols layer | ✅ done | — |
| #11 | C2 — `detect_changes` MCP tool | ✅ done | C1 |
| #12 | C3 — Watch mode + CLI `watch` | ✅ done | A5 |
| #13 | D1 — Auto-augmenting Claude Code hook **[FLAGSHIP]** | ✅ done | — |
| #14 | D2 — Impact-analysis explainability | ✅ done | — |
| #15 | D3 — `trace` tool + fix dead `maxDepth` | ✅ done | — |
| #16 | D4 — Token-budgeted context slicing | ✅ done | — |
| #17 | D5 — Coordinated `rename` tool (preview-only) | ✅ done | — |
| #18 | D6 — Dead-code detection | ✅ done | — |
| #19 | E1 — Deeper cross-file resolution | ✅ done | — |
| #20 | E2 — Queryable complexity metrics | ✅ done | — |
| #21 | E3 — API contract drift (`shape_check`/`api_impact`) | ✅ done | — |
| #22 | E5 — RFC: PDG + interprocedural taint | pending | E1 |

## Commit policy (RULE)
Changed files are **committed as a checkpoint per verified wave** — never left to pile up:
1. **Commit only after a wave passes independent verification** — `pnpm typecheck`, `pnpm typecheck:tests`, `pnpm depcruise src`, and full `pnpm test` all green. Never commit a red or partially-implemented wave.
2. **Never commit while a wave's workflow is still editing the working tree.** Wait for the run to finish, verify, *then* commit, *then* launch the next wave. (Committing mid-run captures partial state.)
3. **One checkpoint commit per wave** on `feature/refactor-code-base`. Message: `feat(wave-N <ids>): <summary>` — e.g. `feat(wave-1 A1–A5): incremental indexing core` — ending with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` footer.
4. **Scope each commit to the wave's files** (`git add` the workflow's reported `filesChanged` + their tests), so unrelated pre-existing dirty files and any in-flight wave stay out.
5. Do not `git push` or open a PR unless explicitly asked.

**Checkpoint status:** Waves 1–5 (A–E concrete, 21 features) are all committed on `feature/refactor-code-base`. E5 (PDG + interprocedural taint — an XL product-line RFC) is **deferred by decision 2026-06-20** — revisit only if explicitly asked; recommended scope is a TS/JS-only MVP behind opt-in `--pdg` first.

**Post-implementation hardening (2026-06-20)** — real-world `typocop parse --refresh` surfaced three runtime issues, all now fixed + tested:
1. **Corrupt-WAL self-heal** — `connection.ts` now quarantines a corrupted WAL (`db.ladybug.wal` → `…corrupt-bak-<ts>`) once on a `Corrupted wal` error and retries, instead of the server fatal-exiting (a killed-mid-write server is the usual cause).
2. **Worker parsing is opt-in** — B1 `worker_threads` parsing can hard-abort the process on a native tree-sitter `Napi::Error` (uncaught C++ exception → `std::terminate`, not catchable in JS). It is now **off by default**; enable with `TYPOCOP_PARSE_WORKERS=1`. The proven in-process path is the default. *(B1's native worker crash is a known follow-up to fix before re-enabling by default.)*
3. **In-place schema migration** — `initializeSchema`/`createTables` now `ALTER TABLE ADD` any missing columns (A4 `file_path`, E2 `cyclomatic`/`cognitive`/`maxLoopDepth`, E3 `responseKeys`/`accessedKeys`) so DBs created by an older typocop are upgraded on connect (`CREATE TABLE IF NOT EXISTS` never migrates). Duplicate-column errors ("already has property") are swallowed.

---

## Part 0 — Cross-cutting foundations (every workstream depends on these)

### 0.1 Stable node identity — `logicalKey` (KEYSTONE; effort: L)
**Problem (verified):** `generateSymbolId(filePath, name, startLine, startColumn)` in
`src/infrastructure/parsing/symbol-id.ts` is **position-inclusive** — a symbol moving one line
gets a new ID, dangling every inbound cross-file edge. This silently breaks any diff-based
re-index.

**Decision:** Add a **position-independent** persisted identity, keep the position-inclusive ID
as the intra-run key.
- New `src/infrastructure/parsing/logical-key.ts`: `generateLogicalKey(filePath, qualifiedName, kind, ordinal) = sha1(filePath \0 qualifiedName \0 kind)`, with a deterministic per-file `ordinal` (assigned in original file order) disambiguating same-(file,name,kind) collisions (e.g. two arrow fns).
- `src/core/domain.ts`: add `readonly logicalKey: string` to `Symbol`.
- The **persisted** node `id`, all edge `source`/`target`, cluster `symbols[]`, process `steps[].symbolId`, and vector `symbolId` switch to `logicalKey`. `startLine`/`endLine`/`startColumn` become mutable props.
- Synthetic IDs must also become position-independent: the import-hint source `${file}:import:${line}` → `${file}:import:${targetName}` (+ ordinal); same for `unresolved:`/`cluster:` ids.
- In-memory lookup tables (dedup, resolution candidate selection) stay keyed on the existing `id`; only the **emitted/persisted** endpoints map to `logicalKey`.

**Why not the alternative** (rewrite all inbound edges of a changed file): that needs a reverse-edge index the graph doesn't maintain + a global edge scan per file change — defeats the incremental win for hub files. `logicalKey` localises the blast radius to a file's own rows.

This is the highest-risk item and **hard-blocks** diff-based persistence (A) and the embedding cache (A).

### 0.2 Caches + port additions (shared by A, B, C)
- **Parse cache** (disk, content-addressed) at `~/.typocop/<prefix>/cache/parse-cache.json`: `relPath → { contentHash, mtimeMs, parseVersion, symbols, hints }`. `parseVersion` bumps on extraction/grammar changes (whole-cache invalidation on upgrade). Two-tier staleness: cheap `mtimeMs` compare → `sha256(content)` confirm. Behind a `core/ports/index-cache.ts` port (`IndexCachePort`), impl in `infrastructure/cache/`.
- **Embedding cache** keyed by `sha256(embedText)` + dimension tag → stored `Embedding`; `core/ports/embedding-cache.ts`. Saves the *other* expensive phase. Add `embeddingCacheHits` to `EmbeddingStats` (don't inflate `attempts`).
- **New optional port methods** (`src/core/ports/persistence.ts`), kept OPTIONAL so remote/other adapters degrade to full-refresh:
```ts
interface GraphAdapter  { deleteSymbolsByFilePaths?(paths: readonly string[]): Promise<number>; } // DETACH DELETE
interface VectorAdapter { deleteByFilePaths?(paths: readonly string[]): Promise<number>; }
```
- Vector embeddings table gains an indexable `file_path STRING` column (written from `metadata.filePath`) so per-file vector deletes are clean (vs slow `JSON_EXTRACT`).

### 0.3 Layering (dependency-cruiser enforced)
`core/` = leaf (domain + ports only) · `platform/` = cross-cutting utils (may use `node:` builtins) ·
`infrastructure/` = adapters, **no sibling-infra imports** (`infra-no-sibling`) · `application/`
= use-cases, **must not shell out / import infra siblings** · `apps/` = composition roots.
New cache/git ports → `core/ports/`; disk/git/watch impls → `infrastructure/*` (self-contained);
hash util → `platform/utils/`; orchestration → `application/indexing/pipeline.ts` (the only
indexing file allowed to import all `indexing/*` subdirs). Adding any per-file-delete/git op to
the gRPC surface requires touching `infrastructure/remote-transport/` — keep ops optional.

### 0.4 Pre-existing bugs to fix opportunistically (found during planning)
- **`Metadata{key:'lastIndexed'}` is read by `status` but never written** anywhere → write it in the persist phase (A). Fixes `status` always showing "never".
- **`SymbolDefinition.{returnType, parameterCount, ownerId}` are declared but `buildSymbolTable`/`ctx.symbols.add` never populate them** → first step of deeper resolution (E1).
- **`find_dependents.maxDepth` is declared+validated but never passed** into `executeImpactAnalysis` → fix in D3.
- **The ingestion bench (`ingestion.bench.test.ts`) mocks out `extractAllSymbols`**, so the parse path is unbenched; the only real-parse harness uses a 3-file fixture → fix in B4.

---

## Part 1 — Workstream A: Incremental Indexing Core

**End-to-end flow:** enrich the file walk with `mtimeMs` → **classify** files (load parse cache;
partition `unchanged | changed | added | removed` by hash/mtime/parseVersion) → parse only
`changed+added` (reuse cached `{symbols,hints}` for the rest) → run the **existing GLOBAL**
`resolveReferences` over the merged set → cluster/process globally → `buildSearchIndex` with the
embedding cache → **diff-write** (per-file delete of `changed+removed`, insert `changed+added`;
rewrite clusters/processes/Metadata wholesale) → save caches + `lastIndexed`. First run (empty
cache) == today's full run; `--refresh` = full delete-all + cache clear.

**Resolution stays global in v1** — the merged symbol+hint set is identical to what a full run
would build, so output is byte-identical; the win is skipping re-PARSE and re-EMBED (the two
expensive phases). Incremental resolution (per-file edge provenance) is deferred to a v2.

### A1. Stable node identity — see Part 0.1 (effort: L). *Build first; gates A4/A3-embed.*

### A2. Persisted parse cache (effort: M; source: GitNexus)
- New: `core/ports/index-cache.ts`, `infrastructure/cache/file-index-cache.ts` (atomic temp+rename write, corrupt/missing → empty), `application/indexing/cache/classify.ts` (pure `classifyFiles`), `platform/utils/hash.ts` (`sha256Hex`).
- Modify: `structure/index.ts` (capture `stat.mtimeMs` onto `FileNode`), `parsing/index.ts` (return per-file results keyed by relPath; surface `contentHash` from the already-read content — no second read), `pipeline.ts` (accept `IndexCachePort` + classify step), `core/file-node.ts` (+`mtimeMs`).
```ts
export interface CachedFileEntry { contentHash: string; mtimeMs: number; parseVersion: number; symbols: Symbol[]; hints: RawRelationshipHint[]; }
export interface IndexCachePort { load(): Promise<Map<string, CachedFileEntry>>; save(m: Map<string, CachedFileEntry>): Promise<void>; clear(): Promise<void>; }
export interface FileClassification { unchanged: FileNode[]; changed: FileNode[]; added: FileNode[]; removed: string[]; }
```
- Tests: `classifyFiles` 4-bucket partition incl. mtime-same/hash-diff + mtime-diff/hash-same; cache round-trip identity; corrupt manifest → no throw; second no-edit run → `filesParsed === 0`.
- Decision: disk JSON over a DB side-table — parse output is read **before** any DB connection, must survive `--refresh`, and temp+rename is simpler than interleaved transactional writes. Save cache **only after** persist succeeds (crash-safety: never desync cache vs DB).

### A3. Embedding cache (effort: M; source: GitNexus)
- New: `core/ports/embedding-cache.ts`, `infrastructure/cache/embedding-cache.ts` (size cap + prune-to-live-hashes each run).
- Modify: `search/index.ts` (`buildSearchIndex` checks cache per job text-hash before embedding; dimension-mismatch = miss), `pipeline.ts` (inject + prune + flush post-run), `limits.ts` (+cache size cap/opt-out env).
```ts
export interface EmbeddingCachePort { get(textHash: string, dims: number): Embedding | undefined; setMany(e: ReadonlyArray<{textHash: string; embedding: Embedding}>): void; prune(live: ReadonlySet<string>): void; flush(): Promise<void>; }
```
- Tests: spy asserts zero `embedFn` calls on unchanged input; dimension change forces miss; `embeddings[]` order identical with/without cache (determinism); one-symbol edit → exactly one embed call.

### A4. Diff-based persistence (effort: L; source: arbor `--changed-only`). *Hard-depends on A1.*
- Modify: `core/ports/persistence.ts` (+ optional per-file deletes, Part 0.2), `infrastructure/persistence/ladybug-graph-adapter.ts` (`MATCH (n:<prefix>Symbol) WHERE n.filePath IN $paths DETACH DELETE n` + count, reuse `execWithParamsSchemaRetry`), `ladybug-vector-adapter.ts` (`file_path` column + delete-by-paths), the `remote-transport` gRPC surface (new ops or client falls back to full-refresh), `pipeline.ts` (delta branch + update `countPersistRows`/drift-guard), `cli/executor.ts` (write `lastIndexed`; report delta stats), `cli/parser.ts` (`--incremental` default / `--full`).
- `DETACH DELETE` of a changed file's symbols transiently drops inbound edges from unchanged files; they are **re-emitted** by the global resolution each run (unchanged files' hints are reused from cache and re-resolved), so edges restore by `logicalKey` — this is exactly why v1 keeps resolution global.
- Tests (LadybugDB integration): **delta == full equivalence** (incremental graph identical to a fresh full index); edit-one-file → only that file's symbols change + inbound cross-file edges intact; removed-file symbols gone; `deleteSymbolsByFilePaths` deletes exactly matching rows; `--full` byte-identical to today.

### A5. Incremental orchestration (effort: M). *Integration point; depends on A1–A4.*
- Pipeline gains `incremental?: boolean` (default true), `cache?: IndexCachePort`, `embeddingCache?: EmbeddingCachePort` in `PipelineConfig`; classify → merge cached+fresh → global resolve → diff-write → save. `cli/executor.ts` builds cache adapters from the prefix-derived path and reports `reused N / parsed M / embedded K`.
- Tests: empty-cache run == `--full`; warm no-edit run = zero parse + zero embed + identical graph; single-edit run = identical to full re-index of the edited tree.
- **Exposes `reindexChangedFiles(paths: string[])`** — the API that Workstream C (watch/CI) builds on.

**A build order:** A1 → A2 → A4 → A3 → A5.

---

## Part 2 — Workstream B: Parallel Parsing & Performance

Phase 2 parsing dominates CPU and runs single-thread: `extractAllSymbols` uses an *async* pool
(`PARSE_CONCURRENCY=4`) that does **not** parallelise synchronous tree-sitter `parse()` across
cores. Verified: `Symbol`/`RawRelationshipHint`/`Location`/`FileNode` are **plain
JSON-serialisable** (no native handles) → worker results are structured-cloneable as-is.
`os.availableParallelism()` available (12 here). Dist already resolves sibling files via
`fileURLToPath(new URL(...))` and native modules via `createRequire` — the worker entry reuses both.

### B1. True multi-core parsing via `worker_threads` (effort: XL; source: GitNexus resilient pool)
- New: `platform/utils/worker-pool.ts` (generic, tree-sitter-agnostic: N persistent workers, index-keyed dispatch, in-order slots, per-task timeout, cumulative-timeout budget, respawn budget, circuit breaker), `infrastructure/parsing/parse-worker.ts` (worker entry: own `Map<variant,Parser>` + query cache, replicates today's `processFile` verbatim, posts plain results, per-task try/catch → never dies on a `ParseError`), `infrastructure/parsing/parse-worker-protocol.ts` (shared message types).
- Modify: `application/indexing/parsing/index.ts` — branch `extractAllSymbols`: below a file-count threshold OR threads disabled/unavailable → **today's exact async path**; above → worker pool. Both feed the **same** slot/flatten/dedup tail → identical output. Signature unchanged (so A and the file-subset incremental path are unaffected).
```ts
export interface ParseTask  { index: number; filePath: string; relativePath: string; language: Language; size: number; }
export type ParseResult = { index: number; symbols: Symbol[]; hints: RawRelationshipHint[] } | { index: number; skipped: true; reason: string };
export interface WorkerPool { run(tasks, onSettled): Promise<{ results: (R|null)[]; breakerTripped: boolean; failedIndices: number[] }>; destroy(): Promise<void>; }
```
- On `breakerTripped` → finish remaining files via the in-process path (indexing never aborts). Worker segfault/crash → reassign that index to a respawned worker (counts against budget); exhausted budget → trip breaker. `pool.destroy()` in `finally`.
- Tests: **determinism gate** — `JSON.stringify(parallel) === JSON.stringify(serial)` for symbols/hints/skippedFiles; order-independence under injected per-task delays; crash isolation (one file throws → counted in `skippedFiles`, others fine); breaker → fallback still produces full set; `onProgress` fires exactly `total` times; fast-check random subsets parallel==serial.
- Decisions: persistent workers reuse parser+query caches (load/compile is the expensive part) → only above threshold (start ~64 files, bench-tune); per-worker query cache means N× compilations (cheap vs parse, race-freedom argument still holds); resolve `.ts` (vitest) vs `.js` (dist) entry via `import.meta.url`.

### B2. Adaptive batch/concurrency tuning (effort: M)
- Modify `limits.ts`: `defaultParseThreads() = clamp(availableParallelism()-1, 1, 16)` (+`TYPOCOP_PARSE_THREADS` override), `PARSE_WORKER_THRESHOLD=64` (+override), `getConfiguredParseThreads()`. Keep `PARSE_CONCURRENCY` as the in-process fallback. **Do not batch embeddings** (measured ~50% slower on CPU — padding waste). Persist-batch caps become bench-swept knobs, changed only on evidence.
- Decision: `cpus-1`, not `cpus` — main thread still does reads/slot assembly/dedup/DB I/O.

### B3. Streaming graph emit — EVALUATE, recommend **NOT now** (effort: M to assess)
- Finding: Phases 3–5 (resolution, clustering, processes) **require the complete symbol set in memory anyway**, and the persist helpers **already chunk** by row + gRPC-byte budget with adaptive splitting. So streaming nodes during Phase 2 can't lower peak memory while later phases need the arrays. GitNexus-style CSV `COPY` fits a parse→emit shape; typocop's global-analysis phases defeat it.
- Instead: **(a)** stream embedding vectors to the vector adapter as built (don't retain the full `embeddings[]` through persist) — the largest concrete win without touching global phases; **(b)** add `peakRssBytes` + per-phase RSS high-water to `IndexingMetrics` so the streaming question becomes data-driven. Revisit true streaming only if a real large repo shows node/edge arrays (not vectors) are the binding constraint.

### B4. Benchmark-driven tuning loop (effort: M)
- New `application/indexing/parsing.bench.test.ts` (RUN_BENCH-gated, stderr-only): generates a large synthetic on-disk tree, runs **real** `extractAllSymbols` across a thread sweep, reports symbols/sec + files/sec + wall + `peakRssBytes`, and **asserts byte-identical output across all thread counts** (doubles as B1's correctness gate). Add `bench:parse` script. Keep a fast non-gated smoke that runs a small fixture through the worker path so CI exercises parallel code.
- Closes the gap: today's ingestion bench mocks parsing. The sweep finalises B2's defaults and B3's decision.

**B build order:** B2 (constants) → B1 (workers) → B4 (bench) → B3 (RSS metric + vector streaming if warranted).

---

## Part 3 — Workstream C: Change-Driven Features

All hang off two existing seams: `executePreCommitCheck(changedFiles, maxResults, graphAdapter)`
(blast radius + risk + flows; already reused by `execute-query.ts`, **not** an MCP tool) and A's
`reindexChangedFiles(paths)`. Git access is a **core port + infra adapter** (layering: application
must not shell out). Diff line-ranges → symbols via persisted `Symbol.filePath/startLine/endLine`.

### C1. Git-diff → changed-symbols layer (effort: M; source: cbm/GitNexus). *Unblocks C2.*
- New: `core/ports/git.ts` (`GitPort`), `infrastructure/git/git-adapter.ts` (shell out via `node:child_process execFile` — no new dep, mirrors `autostart-runtime.ts`; resolve toplevel, parse `--name-status` + `@@` hunks; normalise to cwd-relative + `shouldIgnorePath`), `application/querying/changed-symbols.ts` (`resolveChangedSymbols(fileDiffs, graphAdapter)` — Cypher range-overlap on `[startLine,endLine]`).
```ts
export type DiffScope = "unstaged" | "staged" | "all" | "compare";
export interface FileDiff { path: string; status: "added"|"modified"|"deleted"|"renamed"; oldPath?: string; hunks: { newStart: number; newLines: number }[]; }
export interface GitPort { isRepository(): Promise<boolean>; diff(scope: DiffScope, baseRef?: string): Promise<FileDiff[]>; currentRef(): Promise<string>; }
```
- Decision: shell-out over `isomorphic-git` (no dep, matches repo stance). Self-contained adapter (only `node:` builtins + core types) to satisfy `infra-no-sibling`. Tests: pure parser over canned diff text (rename/add/delete/multi-hunk); `resolveChangedSymbols` with a mocked adapter.

### C2. `detect_changes` MCP tool (effort: M; source: cbm/GitNexus). *The 6th MCP tool.*
- Compose `GitPort` → `resolveChangedSymbols` → existing `executePreCommitCheck` → `formatMCPResponse`. New `apps/mcp-server/detect-changes-tool.ts`; add to `TOOL_DEFINITIONS` (`registration.ts`); `case "detect_changes"` in `tools.ts` (extend `executeTool` with an injected `git: GitPort`); construct `git` in `server.ts`.
- Params `{ scope?, baseRef?, maxResults? }`. Summary e.g. "4 changed files (staged), 12 affected symbols. Risk: CRITICAL. Flows: 3." Reuses `pre-commit-check`'s CRITICAL elevation for auth/payment names. Not-a-repo/no-changes → low-risk response, confidence 0.95.

### C3. Watch mode + CLI `watch` (effort: M; source: GitNexus/cbm). *Depends on A's `reindexChangedFiles`.*
- New: `infrastructure/watch/file-watcher.ts` (chokidar — recommended over `fs.watch` for WSL2 reliability; trailing debounce ~300ms + Set-coalescing + `shouldIgnorePath`). Modify `cli/parser.ts`/`executor.ts` (add `watch` command; single-flight reindex; SIGINT → close + `adapter.close()`).
- Tests: N events → 1 deduped batch; ignore-filter; single-flight no interleave.

**C build order:** C1 → C2; C3 in parallel once A5 lands.

---

## Part 4 — Workstream D: Agent-Facing MCP Tools

New query logic → `application/querying/`; MCP wiring → `apps/mcp-server/` (definitions in
`registration.ts`, dispatch switch in `tools.ts`, `CallToolRequestSchema` handler in `server.ts`,
validation in `validation.ts`). Items D2–D6 are **additive** to `MCPToolResponse` (no field/test
breakage) — coordinate those four shared files to avoid churn.

### D1. Auto-augmenting Claude Code hook (effort: XL; source: GitNexus) — **flagship**
Transparently inject graph context into the agent's Grep/Glob/Bash searches via a fast,
keyword-only, fail-silent path.
- **Hook script** `hooks/claude/typocop-hook.cjs` (zero-dep CJS, not in the TS build): reads stdin JSON, extracts the search pattern (port GitNexus `extractPattern`), acquires a per-repo concurrency slot, probes whether `ladybug-server` owns the DB, `spawnSync`s the CLI `augment` subcommand with a hard timeout, scrapes a `[typocop]`-marked block off stderr, emits `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"…"}}` only when non-empty. Diagnostics → stderr behind `TYPOCOP_DEBUG`.
- **Engine** `application/querying/augment.ts`: keyword-only (reuse `extractKeywords`/`splitIdentifier` from `search/keywords.ts` — **no embeddings**, no FTS in repo so `CONTAINS` + batched `WHERE n.id IN [...]` per relation type), resolve top 1–3 matches via `executeContextRetrieval` (callers/callees/cluster/process, ≤3 each), wrap whole body in try/catch → `""`.
- **CLI** `augment` subcommand writes the block to stderr behind the marker (stdout reserved — native libs print there); **always exits 0**. **`setup`** subcommand idempotently deep-merges the hook into `.claude/settings.json` (`apps/cli/setup.ts`, pure merge + fs split).
- **Guards** `hooks/claude/hook-slot.cjs` (atomic-mkdir slots, cap ~3, reap dead pids) + `hook-db-lock-probe.cjs` (server-owns-DB → silent skip; Unix `timeout` wrap reaps orphaned children). Saturated slot / owned DB = normal silent skip, never an error.
- **Perf <500ms cold:** no embeddings; `spawnSync(timeout:7000)` outer + `withQueryTimeout(~2000)` inner; prefer an already-running server to avoid cold native init (treat embedded cold-start over budget as a silent skip).
- Ship `hooks/` via `package.json` `files`. Tests: `augment` → `""` on unknown/throw/timeout, block for known symbol; `mergeTypocopHook` idempotent + preserves unrelated settings; hook cjs over crafted stdin (Grep/Glob/Bash); saturated slot → empty stdout exit 0.

### D2. Impact-analysis explainability (effort: M; source: arbor)
Additive per-affected-node `entryEdge` (the first-hop edge that pulled it in), `hopDistance`,
`confidence` + `reasons[]`, and a `nodeRole`.
- New `application/querying/explainability.ts` (port arbor `confidence.rs`/`impact.rs` logic). Modify `impact-analysis.ts` (1-hop direct-caller query for `entryEdge`/`hopDistance`; batched degree aggregate; attach optional `explanations[]`), `domain.ts` (optional `nodeRole?`/`entryEdge?`/`hopDistance?` on response symbols), `tools.ts` (map fields + digest into `summary`).
```ts
export type NodeRole = "EntryPoint" | "Utility" | "CoreLogic" | "Isolated" | "Adapter";
// classify from hop-1 in/out degree + export status (arbor rule): (in0,out0)→Isolated, (in0,out>0)→EntryPoint, (in>0,out0)→Utility, skewed→Adapter, else CoreLogic
export interface AffectedNodeExplanation { symbolId: string; nodeRole: NodeRole; entryEdge: RelationType; hopDistance: number; confidence: number; reasons: string[]; }
```

### D3. `trace` shortest-path tool + fix dead `maxDepth` (effort: M; source: GitNexus/arbor)
- New `application/querying/trace-path.ts` (`shortestPath((a)-[:CALLS|CONTAINS*1..$d]->(b))`, clamp `$d` to `MAX_TRAVERSAL_DEPTH`; fall back to TS BFS over `runCypher` if LadybugDB lacks `shortestPath`), `apps/mcp-server/trace-tool.ts`. Register `trace {fromSymbol, toSymbol, maxDepth?}`; thread `maxDepth` through `executeImpactAnalysis`/`findDependents` (fixes the dead param).
```ts
export interface TraceHop { symbolId; name; filePath; startLine; edgeToNext?: RelationType; }
export interface TracePathResult { resolution: {from; to}; found: boolean; hops: TraceHop[]; length: number; }
```

### D4. Token-budgeted context slicing (effort: M; source: arbor)
- New `application/querying/context-slice.ts` (port arbor `slice.rs`: BFS order target→callers→callees, `estimateTokens` via chars/4 heuristic — **no tokenizer dep** in v1, swappable seam for `js-tiktoken` later, pinned nodes first, `TruncationReason = complete|token_budget|max_depth`). Add `tokenBudget?`/`pin?` to `get_symbol_context`; default (no budget) unchanged.

### D5. Coordinated `rename` tool — **preview-only v1** (effort: L; source: GitNexus)
- New `application/querying/rename-plan.ts`: resolve symbol → def + edge-backed references (`CALLS|IMPORTS|REFERENCES`) = high-confidence edits with `file:line`; word-boundary regex descriptor = low-confidence fallback. Always `preview: true`, **no `runCypherWrite`, no fs writes**. New `apps/mcp-server/rename-tool.ts`.

### D6. Dead-code detection (effort: S; source: cbm)
- New `application/querying/dead-code.ts`: `MATCH (s:Symbol) WHERE NOT EXISTS { (s)<-[:CALLS]-() }` then filter out exports + entry-point-named (reuse `ENTRY_POINT_PATTERNS` from `processes/entry-points.ts` — export it). New `find_dead_code` tool; label output "candidates, verify before deletion" (dynamic dispatch caveat). Read-only.

**D build order:** D1's `augment.ts` first (exercises the read-only path), then D2+D3 (share edge projection), then D4+D6, D5 last.

---

## Part 5 — Workstream E: Resolution Depth, Analytics & RFCs

**E1 is foundation-grade** — every query feature inherits edge accuracy. Today resolution is
name-keyed and shallow (calls resolved by bare callee name; single-hop heritage regex;
`SymbolDefinition.{returnType,parameterCount,ownerId}` declared but **unpopulated**).

### E1. Deeper cross-file resolution (effort: XL; source: GitNexus scope-resolution + MRO, cbm Hybrid-LSP)
Each sub-step independently shippable behind a parity guard:
1. **Populate** `SymbolDefinition.{returnType,parameterCount,ownerId}` in `buildSymbolTable` + `ctx.symbols.add` (data only, golden output byte-identical).
2. **`ScopeResolver` registry** (`resolution/scope-resolver.ts` + `resolvers/{typescript,python,java,php,go}.ts`) — slim ~5-field contract (resist GitNexus's ~50-field version); a `single`-strategy default reproduces today's behaviour exactly (CI parity test against `index.test.ts` fixtures).
3. **MRO/C3** (`resolution/mro.ts`, port GitNexus `mro-processor.ts` C3 + `parameterTypesMatch`) → **additive** `overrides`/`methodImplements` edges (never replace INHERITS/IMPLEMENTS).
4. **MRO-aware member-call resolution** — when a call's `receiverText` type is known, walk the linearised ancestor chain instead of the global name fallback.
5. **Chain binding** (`resolution/chain-binding.ts`) — `a.getB().getC()` via `returnType` threading, gated on `propagatesReturnTypes`.
- Modify `extract-symbols.ts`/`queries.ts` (emit return type + param count; add `call.receiver` + `member.access` captures → new hint fields `receiverText?`, `enclosingSymbolId?`), `domain.ts` (+`overrides`/`methodImplements` RelationTypes). Keep all `resolution/*.test.ts` green at every step; add C3-diamond/Java-default-ambiguity/Rust-qualified MRO tests + order-independence property.
- **Unblocks** higher-precision impact/data-flow and is a prerequisite for E5 (PDG/taint).

### E2. Queryable complexity metrics (effort: M; source: cbm). *Independent of E1; parallel-able.*
- New `infrastructure/parsing/complexity.ts` (`computeComplexity(defNode, language)`: cyclomatic = 1 + decision nodes; cognitive = nesting-weighted; `maxLoopDepth`) — pure tree walk in the parsing layer where the live `Tree` exists. Attach `complexity?: ComplexityMetrics` to `Symbol` (`domain.ts`); add the 3 values to the Symbol prop map in `storeInDatabases` (stored as strings; `countPersistRows` unaffected — props, not rows). New `application/querying/hotspots.ts` + `find_hotspots` tool (`ORDER BY toInteger(s.cyclomatic) DESC`). Ship TS/JS/Python/Java/Go decision-node sets first, cyclomatic-only default elsewhere. `transitiveLoopDepth` is a fast-follow needing E1's accurate CALLS edges.

### E3. API contract drift — `shape_check`/`api_impact` (effort: M; source: GitNexus)
- New `infrastructure/parsing/frameworks/response-shape.ts` (`extractResponseKeys`: top-level keys of `res.json({...})`/`return {...}`); attach `responseKeys` to route Symbols (Express/NestJS first); add `member.access` capture (shared with E1) for consumer reads. New `application/querying/shape-check.ts` (route keys vs consumer accessed keys → MISMATCH on missing keys; confidence `low` when a consumer hits multiple routes). New `shape_check` + `api_impact` (= route_map + shape_check + impact) tools. v1: top-level keys only.

### E5. RFC — PDG + interprocedural taint (effort: XL; source: GitNexus `--pdg`)
Per-function CFG → control-dependence (CDG) + reaching-defs → source→sink taint by sink kind
(command/sql/path/xss/code injection). New `BasicBlock` nodes; `CDG`/`REACHING_DEF`/taint edges
(out of the default impact traversal — dedicated `pdg_query`/`explain` tools). Opt-in `--pdg`
(off by default; protects baseline indexing time). **Depends on E1.** Ship TS/JS end-to-end before
generalising (per-language CFG visitors are the bulk — GitNexus has ~15). A product line, not a feature.

---

## Part 6 — Global build order & dependency graph

```
A1 logicalKey ─────────────┐ (KEYSTONE)
                           ├─▶ A4 diff-persist ─▶ A5 incremental ─▶ reindexChangedFiles()
A2 parse-cache ────────────┤                                          │
A3 embed-cache ────────────┘                                          ├─▶ C3 watch
                                                                      │
B2 limits ─▶ B1 workers ─▶ B4 bench ─▶ B3 RSS/stream   (parallel to A; both touch parsing/index.ts — sequence A2's per-file-keying with B1's worker branch)

C1 git-layer ─▶ C2 detect_changes     (C2 needs only C1; C3 needs A5)

D1 augment(flagship)   D2 explainability ─┐
                       D3 trace/maxDepth ─┼─ additive to MCP response (coordinate registration/tools/validation/domain)
                       D4 slice  D5 rename  D6 dead-code ─┘

E1 resolution-depth ─▶ (precision lift for D2/D3, prerequisite for E5)
E2 complexity (parallel)   E3 shape-check (parallel; shares member.access capture with E1/E3)
E5 RFC (separate effort; after E1)
```
**Critical coupling:** A2 (per-file-keyed parsing results) and B1 (worker branch) both edit
`application/indexing/parsing/index.ts` — land A2's keying first or coordinate, since B1's worker
must return the same per-file shape. E1 and E3 both edit `extract-symbols.ts`/`queries.ts`
(`member.access` capture) — share it.

## Part 7 — Phased sequencing (maps to the comparison doc's 5 phases)

| Phase | Items | Net effect |
|---|---|---|
| **1 Foundation** | A1→A5, B2→B1→B4 | incremental + multi-core indexing; `reindexChangedFiles()` exists |
| **2 Agent value** | D1 (hook), D2 (explainability), D3 (trace), C3 (watch) | transparent agent integration + richer impact |
| **3 Change + analytics** | C1→C2, E2 (complexity), D6 (dead-code) | change-driven tools, hotspots |
| **4 Differentiate** | E3 (API drift), D5 (rename), D4 (slice) | quality/refactor surface |
| **5 Strategic RFCs** | E1 (resolution depth — *pull earlier if precision blocks*), E5 (PDG/taint) | new product lines |

> Note: **E1 (resolution depth) is sequenced as an RFC by effort (XL) but is foundation-grade by
> impact** — if edge inaccuracy is observed to limit D2/D3/E3 quality, pull it into Phase 1–2.

## Part 8 — Risk register

| # | Risk | Mitigation |
|---|---|---|
| R1 | `logicalKey` migration dangles edges / collides | Per-file deterministic ordinal; qualifiedName→bare-name fallback; pbt: move-symbol keeps key, collision test; **delta==full** integration test |
| R2 | Incremental cache desyncs from DB after a crash | Save caches **only after** persist succeeds; `parseVersion` whole-cache invalidation; `--refresh` escape hatch |
| R3 | Worker_threads breaks determinism / leaks native handles | Slot-by-original-index + flatten-in-order; workers post **plain** Symbol/hint only; determinism gate test (parallel==serial); `finally` destroy |
| R4 | Worker crash/segfault aborts indexing | Per-task try/catch → skip+count; respawn budget; circuit breaker → in-process fallback |
| R5 | Streaming emit churn for no gain | Don't — global phases need full arrays; measure with peak-RSS first; only stream vectors |
| R6 | Hook adds latency / noise to the agent | Keyword-only, hard `spawnSync` timeout, fail-silent → `""`, slot+lock guard, stderr behind `TYPOCOP_DEBUG` |
| R7 | E1 regresses golden resolution tests | Every step additive or parity-guarded; `single`-strategy default == today; never mutate existing edge ids |
| R8 | New per-file-delete ops absent on remote/gRPC adapter | Keep ports OPTIONAL; client degrades to full-refresh |
| R9 | E3 cross-link false positives (`/health`) | Confidence scoring + param-only-path / multi-route exclusions from day one |

---

### Appendix — most-touched files
`src/application/indexing/pipeline.ts` (A,B,E2/E3) · `.../parsing/index.ts` (A2,B1) ·
`src/infrastructure/parsing/{symbol-id,extract-symbols,queries}.ts` (A1,E1,E2,E3) ·
`src/application/indexing/resolution/{index,symbol-table}.ts` (E1) ·
`src/core/ports/persistence.ts` + `.../persistence/ladybug-*-adapter.ts` (A4) ·
`src/core/domain.ts` (A1,D2,D4,E1,E2,E3) ·
`src/apps/mcp-server/{registration,tools,server,validation}.ts` (C2,D2–D6) ·
`src/apps/cli/{parser,executor}.ts` (A5,C3,D1) · `src/platform/utils/limits.ts` (A,B2).
