# Indexer Performance Improvement Plan

Date: 2026-06-13

Supersedes: none. This is a focused performance plan for the current `src/application/indexing/` pipeline.

## Scope

The current indexer is a six-phase write pipeline:

1. `structure`: walk files and collect `FileNode`s.
2. `parsing`: parse files and extract symbols plus raw relationship hints.
3. `resolution`: resolve hints into typed relationships and external dependency nodes.
4. `clustering`: build communities and enrich cluster names/categories.
5. `processes`: trace execution flows from entry points.
6. `search`: build keyword index, generate embeddings, and persist graph/vector data.

The module is structurally clean, but it is biased toward simple sequential execution. That makes correctness easy to reason about, but it leaves large performance wins untaken.

## Current Bottlenecks

### 1. No phase timing or benchmark baseline

`runIndexingPipeline` logs phase start and count summaries, but does not measure elapsed time, throughput, write counts, embedding counts, or per-phase failure/skipped counts beyond files and embeddings. There is also no dedicated indexing benchmark, despite the documented target of at least 10,000 LOC/s.

Impact: every optimization is hard to validate. The first change should make the current slowness measurable.

### 2. Phase 2 parses files serially, reparses for queries, and recompiles queries per file

`extractAllSymbols` (`src/application/indexing/parsing/index.ts`) processes each `FileNode` in a single loop. For every file it calls `parseFile`, then `extractSymbolsWithQueries`. Three distinct costs stack up per successful file:

1. **Double parse.** `parseFile` (`src/infrastructure/parsing/parse-file.ts`) reads the file, parses it with an adaptive `bufferSize`, then eagerly walks the entire tree-sitter tree into a plain-object `ASTNode` tree via `fromSyntaxNode` and returns only that. `extractSymbolsWithQueries` (`src/infrastructure/parsing/extract-symbols.ts:131`) then throws that away and calls `parser.parse(ast.text)` a second time to get a real `Tree` it can query. So each file is parsed twice, and a full eager AST is materialized that the query path never reads (only the fallback path and the reparse-input string use it).
2. **Per-file query compilation.** `extractSymbolsWithQueries` runs `new Parser.Query(lang, queryString)` on every call (`extract-symbols.ts:125`). The S-expression query for a language is fixed (`LANGUAGE_QUERIES` in `queries.ts`), so this compilation is repeated once per file instead of once per language.
3. **Eager AST allocation.** `fromSyntaxNode` recursively allocates an object-per-node copy of the whole tree for every file, driving GC pressure on large files.

Likely impact: high. CPU- and memory-heavy, scales with file count and file size, and runs entirely before later phases can start.

Note a latent correctness trap inside the double parse: the first parse uses `getTreeSitterBufferSize(content.length)` (adaptive, up to 32 MB), but the reparse at `extract-symbols.ts:131` passes no `bufferSize`, so it falls back to tree-sitter's default. Large files can therefore parse fully on the first pass and be silently truncated on the second, yielding fewer symbols than the file actually contains. Eliminating the reparse removes this discrepancy outright.

### 3. Phase 6 embedding generation is fully serial

`buildSearchIndex` awaits one embedding per symbol, then one embedding per cluster. Cluster enrichment can also call embeddings during Phase 4 for semantic classification.

Likely impact: very high when embeddings are enabled, especially with Ollama, HuggingFace, or remote adapters. Existing issue docs already identify sequential embedding as a problem.

### 4. Persistence writes are one call per row

The pipeline stores:

- every symbol node individually,
- every cluster node individually,
- every process node individually,
- every external dependency node individually,
- every relationship individually,
- every cluster membership edge individually,
- every process step edge individually,
- every embedding individually.

In embedded mode this means many separate LadybugDB queries. In remote mode it also means one gRPC round trip per item. The public adapter interfaces currently expose per-row graph/vector writes, while `GraphAdapter.runCypherWrite` exists but the Ladybug implementation ignores params.

Likely impact: very high for large graphs and remote connection-server mode.

### 5. Phase 3 has avoidable repeated scans

`resolveHints` builds useful maps, but then repeatedly searches arrays:

- call hints find the caller with `fileSym.find(...)` for every call hint,
- parent/interface resolution uses `symbolMap.get(name).find(...)`,
- import resolution calls the resolution context, then falls back through several map lookups.

There is also a suspicious lookup where `ctxResult.candidates[0].nodeId` appears to be a symbol id, but the code looks it up in `symbolMap`, which is keyed by symbol name. That falls through to slower fallback paths and may hide correctness issues.

Likely impact: medium to high on files with many call hints.

### 6. Phase 5 duplicates call graph construction

`traceProcesses` builds a call graph, then `findEntryPoints` builds another call graph internally from the same symbol and relationship arrays.

Likely impact: low to medium, but easy to remove. It matters once relationship counts are large.

### 7. External dependency edges can amplify write volume

For an external import hint, `resolveHints` creates a `DEPENDS_ON` relationship from every symbol in the importing file to the external dependency node. A file with many symbols and several external imports can multiply edge count quickly.

Likely impact: medium to high in dependency-heavy files. Changing this has semantic implications, so it should be measured and tested before altering behavior.

### 8. Parser-state hazards that block safe parallelization

Two existing behaviors are correctness bugs today and become *concurrency* bugs the moment Phase 2 parses files in parallel. They must be fixed before, or as part of, parallelization — not after.

- **Sticky TSX grammar on a shared parser.** Parsers are cached per `Language` in `extractAllSymbols`, so every `.ts` and `.tsx` file shares one `typescript` parser instance. `applyTsxGrammarIfNeeded` (`parse-file.ts:22`) switches that shared parser to the `tsx` grammar for a `.tsx` file but never restores it. After the first `.tsx` file, subsequent plain `.ts` files are parsed with the tsx grammar, which mis-parses constructs the tsx grammar reads differently (e.g. `<T>` type assertions vs JSX). Serially this is already an ordering-dependent bug; with concurrent parses sharing one mutable parser it is also a data race.
- **Inconsistent symbol-ID schemes.** The query path emits IDs as `${filePath}:${name}:${row}` with no column (`extract-symbols.ts:158`), while the fallback path uses `generateSymbolId(...)` which includes the column (`parsing/index.ts:33`). Two symbols on the same line collide under the query scheme, and `deduplicateById` then drops one. The two schemes also make IDs non-comparable across the query and fallback paths.

Likely impact: medium for performance, but high for correctness — these silently lose or merge symbols, and they cap how aggressively Phase 2 can be parallelized.

## Improvement Plan

### Phase A: Instrument before optimizing

Add an internal timing/metrics layer around `runIndexingPipeline`:

- elapsed milliseconds per phase,
- files scanned, files parsed, skipped files,
- symbols, hints, relationships, clusters, processes, external dependencies,
- graph node write count, graph edge write count, vector write count,
- embedding generation count and elapsed time,
- optional verbose throughput summary.

Add a repeatable benchmark fixture and command, for example `pnpm vitest --run src/application/indexing/indexer-performance.test.ts` or a `pnpm run benchmark:indexing` script if the project wants non-test benchmarks.

Acceptance criteria:

- baseline timings can identify the top two slow phases on the local repo,
- metrics are available without sending source to external services,
- normal CLI output stays concise unless verbose mode is enabled.

Phase 2 is the highest-leverage CPU work in the pipeline and currently does roughly 2× the parsing it needs to, on top of two latent correctness bugs. Fix correctness and redundant work *first* (single-threaded, easy to verify), then parallelize on top of the now-safe foundation. Do not reorder these steps — parallelization on the current shared-parser design would race.

#### B1. Remove the double parse and the throwaway eager AST

Split parsing into a lower-level entry point that returns the real tree-sitter artifacts, so the query path never reparses:

- Add `parseSourceFile(filePath, language, parser)` returning `{ content, tree, diagnostics }` (or at least `{ content, rootNode }`). It performs the single parse with the adaptive `getTreeSitterBufferSize(content.length)` and runs diagnostics collection.
- Change `extractSymbolsWithQueries` to accept the existing `Parser.Tree`/`SyntaxNode` (and the source `content` for any text needs) instead of an `ASTNode` plus an internal `parser.parse(ast.text)`.
- Build the eager `fromSyntaxNode` `ASTNode` tree **lazily**, only on the fallback path (when query compilation fails or yields zero symbols). The common path should never materialize it.
- Keep `parseFile`'s current `ASTNode`-returning signature as a thin wrapper if other callers depend on it, but route Phase 2 through `parseSourceFile`.

This alone removes the reparse, the reparse buffer-size discrepancy (bottleneck 2 note), and the per-file eager AST allocation.

#### B2. Compile tree-sitter queries once per language

Cache compiled `Parser.Query` objects keyed by `(language, grammarVariant)` — grammarVariant matters because `tsx` vs `ts` are distinct grammars (see B3). Compile on first use, reuse for every subsequent file of that language. This is the Phase F query-cache item, pulled forward because it is cheap and squarely in the parse hot path.

#### B3. Make grammar selection stateless (fixes the sticky-TSX bug, bottleneck 8)

Stop mutating a shared parser's grammar mid-stream. Options, simplest first:

- Key the parser cache by *grammar variant*, not just `Language`: treat `.tsx` as its own cache entry with the tsx grammar set once at init, and `.ts`/`.js` as another. No per-file `setLanguage`, so nothing to "restore."
- Or, if a single parser must be reused, explicitly set the correct grammar before every parse (and accept that this precludes sharing one parser across concurrent parses).

Prefer the per-variant cache — it is also what makes B4 safe.

#### B4. Unify the symbol-ID scheme (fixes bottleneck 8)

Make both the query path and the fallback path emit IDs through a single `generateSymbolId(filePath, name, startLine, startColumn)`. Include the column so same-line symbols don't collide. Verify `deduplicateById` behavior against the new scheme with a fixture that has multiple symbols on one line.

#### B5. Parallelize parsing with bounded concurrency

Only after B1–B4: process files with a bounded-concurrency map (default conservative, e.g. 4–8, centralized via a constant in `src/platform/utils/limits.ts`). Give each concurrent slot its **own** parser instance per grammar variant — never share a mutable `Parser` across in-flight parses. A per-worker `Map<grammarVariant, Parser>` keeps reuse within a slot while isolating slots from each other.

Also avoid re-statting in `parseFile` when Phase 1 already collected `FileNode.size`: pass the known size through and trust the Phase 1 size check, or skip the `fs.stat` when size is provided.

#### B6. Surface parse progress with a progress bar

Phase 2 is the longest CPU-bound phase and currently reports nothing between "Starting Phase 2" and "Phase 2 complete" (`pipeline.ts:88,92`). On a large repo this looks like a hang. Add an incremental progress indicator driven by per-file completion.

Wiring:

- Give `extractAllSymbols` an optional `onProgress?: (done: number, total: number, currentPath?: string) => void` parameter (or an options object, to leave room for the concurrency knob from B5). `total` is `fileNodes.length`, known up front from Phase 1.
- Invoke `onProgress` as each file finishes parsing — once per file, including skipped files, so the bar always reaches `total`. Under B5's bounded concurrency, increment a shared completed-counter as each task settles (the count is the only shared state; keep it a simple integer bump, order-independent).
- The pipeline owns rendering, not the parser. `runIndexingPipeline` passes an `onProgress` that renders to **stderr** (consistent with all existing pipeline logging, and keeps stdout/MCP output clean).

Rendering rules:

- Only animate when `process.stderr.isTTY` is true. Render with a carriage-return-rewound single line (e.g. `\r[pipeline] Phase 2: parsing ▕████░░░░▏ 1234/5000 (25%)`) and clear it on completion. tree-sitter parsing is synchronous and can starve the event loop, so throttle redraws (e.g. at most every ~16–50 ms, or every N files) rather than once per file.
- When stderr is **not** a TTY (CI logs, redirected output, MCP server stdio), do not emit escape codes. Fall back to occasional plain line logs (e.g. every 10% or every K files) under the existing `verbose` flag, so non-interactive runs stay readable and quiet by default.
- Never write the bar to stdout, and gate any non-TTY chatter on `verbose` so MCP/server mode is unaffected.

Keep the renderer tiny and dependency-free (a few lines of string building), or reuse a progress helper if one already exists in `src/platform/`; do not add a heavy progress-bar dependency. The per-file timing this requires overlaps with the Phase A metrics layer — share the same completion hook rather than instrumenting twice.

B6 acceptance criteria:

- Phase 2 shows incremental progress on an interactive terminal and reaches 100% even when files are skipped;
- no ANSI/escape output when stderr is not a TTY; non-interactive progress is plain-text and verbose-gated;
- nothing is written to stdout, so MCP/server mode output is unchanged;
- the progress counter is correct under bounded-concurrent parsing (B5) — `done` ends exactly at `total`;
- redraws are throttled so progress rendering is not itself a measurable cost in the Phase A benchmark.

Acceptance criteria:

- the common path parses each file exactly once and never builds the eager `ASTNode` tree;
- query compilation count is proportional to (language × grammar variant), not file count;
- a `.ts` file parsed after a `.tsx` file produces identical symbols regardless of order (regression test for the sticky-grammar bug);
- query and fallback paths produce IDs in the same scheme, with a same-line-collision test;
- fallback structural extraction and syntax-diagnostic behavior are preserved;
- tests cover skipped files, mixed-language parser reuse, and concurrent parsing of a multi-file fixture with no shared-parser races;
- measured Phase 2 wall time improves on a multi-file fixture (validated against the Phase A baseline).

### Phase C: Bound and batch embedding work

Change `buildSearchIndex` to run embeddings with a bounded concurrency helper. Start with provider-safe defaults:

- local Ollama/HuggingFace: 2-4 concurrent calls by default,
- remote or HTTP providers: configurable but capped,
- no unbounded `Promise.all`.

Add timeout and failure accounting per embedding so one slow item does not stall the whole index. Preserve the current behavior that embedding failures produce keyword-only search data rather than failing the pipeline.

Avoid duplicate cluster embedding work where possible. Phase 4 semantic classification embeds cluster text, then Phase 6 embeds cluster search text again. Cache per-cluster formatted text and embedding result when the same adapter is used, or make semantic cluster classification opt-in if it dominates indexing time.

Acceptance criteria:

- embedding generation remains privacy-checked,
- failures are logged with counts, not swallowed silently,
- embedding ordering is deterministic enough for tests,
- wall time improves when embedding adapters have non-trivial latency.

### Phase D: Batch graph and vector persistence

Introduce optional batch methods rather than forcing all adapters to change at once:

- `GraphAdapter.createNodes(label, nodes)` or `GraphAdapter.createGraphBatch(batch)`,
- `GraphAdapter.createRelationships(type, relationships)`,
- `VectorAdapter.indexSymbols(entries)`.

Keep the current per-row methods as fallback defaults.

For LadybugDB, implement batches with one query per label/type chunk. For remote adapters, add batch RPC endpoints so connection-server mode avoids one gRPC call per node/edge/embedding.

Fix or avoid the current `runCypherWrite` parameter gap before relying on parameterized bulk Cypher. The Ladybug graph adapter currently accepts `params` but does not pass them to execution.

Acceptance criteria:

- graph writes group by node label and relationship type,
- write chunks have bounded size,
- prefix behavior remains adapter-owned,
- existing graph/vector adapter tests still pass,
- pipeline tests assert batch path when available and fallback path otherwise.

### Phase E: Tighten Phase 3 indexes

Build indexes once in `resolveHints`:

- `symbolById`,
- `symbolsByFile`,
- `symbolsByFileAndName`,
- caller lookup by file and line range,
- parent/interface candidate lookup by name and file proximity.

Replace repeated `.find(...)` scans with indexed lookups. Validate the `ctxResult.candidates[0].nodeId` path and resolve by `symbolById` if it is indeed an id.

Do not change external dependency fan-out in the same step. First report how many `DEPENDS_ON` edges are generated per file/import, then decide whether dependency edges should attach to importing symbols, file nodes, or a synthetic import node.

Acceptance criteria:

- relationship counts remain unchanged except for explicitly approved bug fixes,
- resolution tests cover same-file calls, duplicate names, imports, inheritance, and external dependencies,
- property tests preserve valid source/target invariants.

### Phase F: Remove smaller repeated work

Pass the call graph into entry-point detection so Phase 5 does not build it twice.

Cap traced entry points by score for very large graphs, or add a configurable threshold if metrics show too many traces. Keep the default behavior unchanged until a benchmark demonstrates the need.

Tree-sitter query compilation caching has moved into Phase B (step B2), since it lives in the parse hot path and should land with the double-parse fix. If B2 has not been done by the time Phase F runs, do it here instead.

Acceptance criteria:

- process tracing output remains stable for existing tests,
- query compilation count is proportional to (language × grammar variant), not file count (verified once, wherever it lands),
- changes are covered by focused unit tests.

## Suggested PR Sequence

1. Metrics and benchmark harness only. No behavior changes.
2. Phase 2 single-parse refactor (B1) plus query compilation cache (B2). No behavior change to symbol output expected.
3. Phase 2 parser-state correctness fixes: stateless grammar selection (B3) and unified symbol-ID scheme (B4). These are bug fixes; expect symbol-count deltas on `.tsx`-adjacent and same-line cases, covered by new regression tests.
4. Bounded concurrent Phase 2 parsing with per-slot parsers (B5), on top of 2 and 3. Include the `onProgress` completion hook (B6 wiring) here, since the per-file callback is the same one the concurrency loop needs.
5. Parse-phase progress bar rendering (B6): TTY-aware stderr renderer driven by the B6 hook, with verbose-gated plain-text fallback.
6. Bounded concurrent embeddings with timeout/failure metrics.
7. Optional batch adapter interfaces and pipeline fallback behavior.
8. Ladybug embedded batch writes.
9. Remote batch RPC writes.
10. Phase 3 lookup indexes and the `nodeId` resolution fix if verified.
11. Phase 5 call-graph reuse and optional entry-point cap.

## Risk Notes

- Parallel parsing must not share a mutable tree-sitter parser across concurrent parses. The current `applyTsxGrammarIfNeeded` mutates a shared parser's grammar and never restores it (bottleneck 8); parallelizing before fixing this (B3) would turn an ordering bug into a data race. Each concurrency slot needs its own parser per grammar variant.
- The Phase 2 correctness fixes (B3 sticky grammar, B4 ID scheme) will change symbol output in specific cases. Land them as explicit bug-fix PRs with regression tests and a before/after symbol-count diff, not silently folded into the parallelization PR.
- Database write concurrency should stay conservative. Batch writes are safer than firing many writes in parallel.
- Embedding concurrency must be bounded because local model backends can become slower under overload.
- Changing external dependency edge fan-out may affect query behavior, so treat it as a separate semantic decision after metrics.
- Adapter interface changes affect embedded and remote implementations, server RPC services, and tests; keep per-row fallbacks during migration.

## First Recommendation

Start with instrumentation (Phase A), then the Phase 2 single-parse + query-cache refactor (B1, B2). Those are low-risk, should produce immediate local indexing gains, and create the visibility needed to choose between embedding concurrency and persistence batching next. Treat the parser-state correctness fixes (B3 sticky TSX grammar, B4 ID scheme) as a required prerequisite to *parallel* parsing (B5) — they are bug fixes that also unblock safe concurrency, so do them before reaching for more parser throughput.
