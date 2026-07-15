// Resource limits — enforced throughout the system (Req 23)

import os from "node:os";

/** Minimum cosine similarity score for semantic search results (Req 17.3) */
export const SEMANTIC_SEARCH_THRESHOLD = 0.45;

/** Maximum source file size in bytes before skipping during indexing (Req 23.1) */
export const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512 KB — matches two-phase scan threshold

/** Alias used by the parser module */
export const MAX_FILE_SIZE = MAX_FILE_SIZE_BYTES;

/**
 * Minimum tree-sitter buffer size (512 KB).
 * tree-sitter requires bufferSize >= file size in bytes.
 */
export const TREE_SITTER_BUFFER_SIZE = 512 * 1024;

/**
 * Maximum tree-sitter buffer size cap (32 MB) to prevent OOM on huge files.
 * Also used as the file-size skip threshold for very large files.
 */
export const TREE_SITTER_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Compute adaptive buffer size for tree-sitter parsing.
 * Uses 2× file size, clamped between 512 KB and 32 MB.
 */
export const getTreeSitterBufferSize = (contentLength: number): number =>
  Math.min(Math.max(contentLength * 2, TREE_SITTER_BUFFER_SIZE), TREE_SITTER_MAX_BUFFER);

/**
 * Bounded concurrency for the IN-PROCESS async-pool parsing FALLBACK (B5/B2).
 *
 * This is the fallback path used when worker-thread parsing (B1) is disabled,
 * unavailable, or below {@link PARSE_WORKER_THRESHOLD} — it does NOT parallelise
 * synchronous tree-sitter `parse()` across CPU cores; it only bounds how many
 * parses are in flight on the single main-thread event loop. For true
 * multi-core parsing see {@link defaultParseThreads}/{@link getConfiguredParseThreads}.
 *
 * Conservative default (plan recommends 4–8). Each concurrent slot owns its own
 * per-grammar-variant `Parser` instances, so a tree-sitter parser is never
 * shared across in-flight parses. Higher values trade memory (more parser
 * instances) for throughput; keep it modest to avoid starving the event loop
 * during synchronous tree-sitter parses.
 */
export const PARSE_CONCURRENCY = 4;

/**
 * Upper bound on the number of parse worker threads (B2).
 *
 * Caps {@link defaultParseThreads} regardless of core count: beyond this point
 * the main thread (reads, slot assembly, dedup, DB I/O) becomes the bottleneck
 * and extra workers only add memory + scheduling overhead.
 */
export const MAX_PARSE_THREADS = 16;

/**
 * Number of parse worker threads to use by default (B2).
 *
 * `clamp(availableParallelism() - 1, 1, MAX_PARSE_THREADS)`. We reserve one core
 * for the main thread, which still does file reads, in-order slot assembly,
 * dedup and DB I/O while the workers parse. `os.availableParallelism()` (Node
 * >=19) reflects scheduler/cgroup affinity; we fall back to `os.cpus().length`
 * on the rare platform where it is unavailable.
 */
export function defaultParseThreads(): number {
  const available =
    typeof os.availableParallelism === "function"
      ? os.availableParallelism()
      : os.cpus().length;
  // Guard against a 0/NaN report from an exotic platform.
  const cores = Number.isFinite(available) && available > 0 ? available : 1;
  return Math.min(Math.max(cores - 1, 1), MAX_PARSE_THREADS);
}

/** Environment override for the parse worker-thread count ({@link getConfiguredParseThreads}). */
export const PARSE_THREADS_ENV = "TYPOCOP_PARSE_THREADS";

/**
 * Resolve the configured parse worker-thread count from the environment (B2).
 *
 * Honors {@link PARSE_THREADS_ENV}; when unset/empty falls back to
 * {@link defaultParseThreads}. An explicit override is NOT re-clamped to the
 * core count (so a user may oversubscribe deliberately) but must be a positive
 * integer — `<= 0` / non-numeric values throw (reuses the shared positive-int
 * env validation).
 */
export function getConfiguredParseThreads(): number {
  return getConfiguredPositiveIntEnv(PARSE_THREADS_ENV, defaultParseThreads());
}

/**
 * File-count threshold above which parsing uses the worker-thread pool (B1/B2).
 *
 * Below this many files the per-worker parser/query compilation cost outweighs
 * the parallelism win, so the in-process {@link PARSE_CONCURRENCY} async path is
 * used instead. Start at 64; finalise via the B4 benchmark sweep.
 */
export const PARSE_WORKER_THRESHOLD = 64;

/** Environment override for {@link PARSE_WORKER_THRESHOLD} ({@link getConfiguredParseWorkerThreshold}). */
export const PARSE_WORKER_THRESHOLD_ENV = "TYPOCOP_PARSE_WORKER_THRESHOLD";

/**
 * Resolve the configured parse worker-pool file-count threshold from the
 * environment (B2). Honors {@link PARSE_WORKER_THRESHOLD_ENV}; when unset/empty
 * falls back to {@link PARSE_WORKER_THRESHOLD}. Must be a positive integer —
 * `<= 0` / non-numeric values throw.
 */
export function getConfiguredParseWorkerThreshold(): number {
  return getConfiguredPositiveIntEnv(PARSE_WORKER_THRESHOLD_ENV, PARSE_WORKER_THRESHOLD);
}

/** Environment opt-in for multi-core worker_threads parsing ({@link isParseWorkersEnabled}). */
export const PARSE_WORKERS_ENV = "TYPOCOP_PARSE_WORKERS";

/**
 * Whether multi-core `worker_threads` parsing (B1) is enabled. **OPT-IN — default
 * `false`.** The in-process async path is the proven default; the worker path can
 * hard-abort the whole process on a native tree-sitter (`Napi::Error`) thrown
 * inside a worker thread in some environments (it escapes JS `try/catch` as an
 * uncaught C++ exception → `std::terminate`). It must therefore be enabled
 * explicitly: set `TYPOCOP_PARSE_WORKERS=1` (or `true`/`yes`/`on`). The pool is
 * still exercised in tests via an injected `poolFactory` seam.
 */
export function isParseWorkersEnabled(): boolean {
  const raw = process.env[PARSE_WORKERS_ENV];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Environment opt-in for the Wave 3 Tier-B AST type-env ({@link isTypeEnvEnabled}). */
export const TYPE_ENV_ENV = "TYPOCOP_TYPE_ENV";

/**
 * Whether the Wave 3 Tier-B AST type-environment resolution is enabled. **OPT-IN
 * — default `false`.** Gates (a) building the per-file type-env in Phase 2,
 * (b) populating `RawRelationshipHint.receiverType`, (c) the `receiverType`-first
 * branch in `resolveMemberCallTarget` (Phase 3), and (d) the ported
 * `extractReturnTypeName` swap in chain-binding. When unset, none of those fire
 * and the emitted graph is byte-identical to pre-Wave-3.
 *
 * Read in BOTH Phase 2 (inside `extractSymbolsWithQueries`, which runs in parse
 * workers that inherit `process.env`) and the composition root (to derive
 * `PipelineConfig.typeEnvResolution` for Phase 3) — both consult this single env
 * so the two phases agree. Mirrors the {@link isParseWorkersEnabled} pattern.
 */
export function isTypeEnvEnabled(): boolean {
  const raw = process.env[TYPE_ENV_ENV];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Environment opt-in for the Wave 3 Tier-A LSP / TS-compiler-API type tier ({@link isLspTypesEnabled}). */
export const LSP_TYPES_ENV = "TYPOCOP_LSP_TYPES";

/**
 * Whether the Wave 3 Tier-A (A1) compiler-API receiver-type resolution is
 * enabled. **OPT-IN — default `false`.** When `true`, a post-Phase-2,
 * whole-corpus pass builds ONE TypeScript `Program` per project (via a LAZY
 * `await import("typescript")` — the ~tens-of-MB compiler is NEVER loaded when
 * this is off) and, for TS/JS `call` hints, resolves the receiver's nominal type
 * from the real type checker. That answer is stamped onto `hint.receiverType`
 * with PRECEDENCE over the Tier-B (`TYPOCOP_TYPE_ENV`) AST answer; Phase 3 then
 * consumes `hint.receiverType` uniformly (no Phase-3 change beyond Tier B).
 *
 * The two tiers are independent flags (plan §10): Tier A (this) → Tier B → the
 * parity selector. When this is off the compiler is never imported and the
 * emitted graph is byte-identical to a Tier-A-absent run.
 *
 * Heavy + new + measurement-gated (plan §8): the default stays OFF until a
 * large-repo perf measurement justifies flipping it. Mirrors the
 * {@link isParseWorkersEnabled} / {@link isTypeEnvEnabled} reader pattern.
 */
export function isLspTypesEnabled(): boolean {
  const raw = process.env[LSP_TYPES_ENV];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Shared truthy-env parser (`1`/`true`/`yes`/`on`, default `false`). */
function isEnvTruthy(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Shared falsy-env parser (`0`/`false`/`no`/`off`, default `false` — i.e. unset
 *  is NOT falsy). Used for opt-OUT flags that default ON. */
function isEnvFalsy(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

/** Environment opt-in for the Wave 5 data-touch detection pass ({@link isDataTouchEnabled}). */
export const DATA_TOUCH_ENV = "TYPOCOP_DATA_TOUCH";
/** Environment opt-in for the Wave 5 heuristic event detector ({@link isDataTouchEventsEnabled}). */
export const DATA_TOUCH_EVENTS_ENV = "TYPOCOP_DATA_TOUCH_EVENTS";
/** Environment opt-in for the Wave 5 single-model DB fallback ({@link isDataTouchSingleModelFallbackEnabled}). */
export const DATA_TOUCH_SINGLE_MODEL_FALLBACK_ENV = "TYPOCOP_DATA_TOUCH_SINGLE_MODEL_FALLBACK";

/**
 * Whether the Wave 5 data-touch detection pass is enabled. **OPT-IN — default
 * `false`.** Gates the whole post-resolution pass that detects DB models /
 * route handlers and emits `readsFromDb`/`writesToDb`/`handlesRoute` edges (plus
 * synthetic anchor Symbols). When unset the pass never runs and the emitted graph
 * is byte-identical to pre-Wave-5. Derived at the composition root into
 * `PipelineConfig.dataTouch`; mirrors the {@link isTypeEnvEnabled} reader pattern.
 */
export function isDataTouchEnabled(): boolean {
  return isEnvTruthy(DATA_TOUCH_ENV);
}

/**
 * Whether the Wave 5 heuristic event detector is enabled (sub-flag of the
 * data-touch pass — conceptually `dataTouch.events`). **OPT-IN — default
 * `false`.** Pure-heuristic `emit`/`publish`/`send` detection is noisy (the
 * publish verbs are wildly overloaded), so the event detector stays dark until
 * Wave 6 supplies extracted channel args. Only meaningful when
 * {@link isDataTouchEnabled} is also on.
 */
export function isDataTouchEventsEnabled(): boolean {
  return isEnvTruthy(DATA_TOUCH_EVENTS_ENV);
}

/**
 * Whether the Wave 5 single-model DB fallback (strategy 5) is enabled (sub-flag
 * of the data-touch pass — conceptually `dataTouch.singleModelFallback`).
 * **OPT-IN — default `false`.** This is the noisiest DB-resolution strategy
 * (links any DB call to the sole model when exactly one exists), so it is gated
 * off by default to favour precision over recall. Only meaningful when
 * {@link isDataTouchEnabled} is also on.
 */
export function isDataTouchSingleModelFallbackEnabled(): boolean {
  return isEnvTruthy(DATA_TOUCH_SINGLE_MODEL_FALLBACK_ENV);
}

/** Environment opt-in for the Wave 6 framework-extraction pass ({@link isFrameworkExtractionEnabled}). */
export const FRAMEWORK_EXTRACTION_ENV = "TYPOCOP_FRAMEWORK_EXTRACTION";

/**
 * Whether the Wave 6 framework-extraction pass is enabled. **OPT-IN — default
 * `false`.**
 *
 * NOTE — DELIBERATE DEVIATION from the wave plan's default-ON: for program-wide
 * consistency and safety this flag ships **default-OFF**, like the other gated
 * waves ({@link isDataTouchEnabled} / {@link isCallRefuseAmbiguousEnabled}).
 * Tests enable it explicitly; the operator flips it on alongside data-touch.
 *
 * When OFF, the per-file framework pass never runs and Phase-2 output
 * (symbols/hints/records) is byte-identical to pre-Wave-6 for ALL files. When ON,
 * the pass is gated PER FILE by a cheap path + source-text probe, so
 * non-framework files still produce byte-identical output. Read directly inside
 * the parse worker (`runParseTask`), which inherits `process.env`, so the worker
 * and in-process paths agree — and also derived at the composition root into
 * `PipelineConfig.frameworkExtraction` for per-run testability. Mirrors the
 * {@link isParseWorkersEnabled} / {@link isTypeEnvEnabled} reader pattern.
 */
export function isFrameworkExtractionEnabled(): boolean {
  return isEnvTruthy(FRAMEWORK_EXTRACTION_ENV);
}

/** Environment flag for the short-lived Laravel AST-vs-regex routing A/B ({@link isLaravelAstRoutesEnabled}). */
export const LARAVEL_AST_ROUTES_ENV = "TYPOCOP_LARAVEL_AST_ROUTES";

/**
 * Whether the Wave 6 (Task 8) AST Laravel route extractor REPLACES the legacy
 * regex `parseRouteDefinitions` route emission. **Default `true` (ON).**
 *
 * SHORT-LIVED A/B flag (Task 8): the AST extractor (`extractLaravelRoutes`) is a
 * strict superset of the regex (it captures everything the regex did plus
 * handlers/groups/resources), so it ships ON by default and is the only Laravel
 * route producer the live pipeline uses (the dispatcher calls `extractLaravelRoutes`
 * directly; the regex `parseRouteDefinitions` is dead scaffolding). This flag exists
 * for ONE release so an operator can fall back to the regex route emission while
 * route-count parity is confirmed on a real Laravel repo, then it is removed.
 *
 * Set `TYPOCOP_LARAVEL_AST_ROUTES=0`/`false` to restore the regex route emission in
 * the (dead) `parseRouteDefinitions` path. Mirrors the {@link isFrameworkExtractionEnabled}
 * reader pattern but defaults ON (opt-OUT) because the AST extractor is the
 * confirmed superset.
 */
export function isLaravelAstRoutesEnabled(): boolean {
  return !isEnvFalsy(LARAVEL_AST_ROUTES_ENV);
}

/** Environment opt-in for the Wave 4 refuse-on-ambiguity call discipline ({@link isCallRefuseAmbiguousEnabled}). */
export const CALL_REFUSE_AMBIGUOUS_ENV = "TYPOCOP_CALL_REFUSE_AMBIGUOUS";

/**
 * Whether the Wave 4 (Task 5) refuse-on-ambiguity call-resolution discipline is
 * enabled. **OPT-IN — default `false`.** When `true`, Phase 3's call-target
 * selector narrows candidates by callable-kind + arity + receiver-type and emits
 * a `calls` edge ONLY when exactly one candidate survives (otherwise no edge),
 * trading bounded recall for precision. When unset, the selector runs the
 * byte-identical legacy `candidates[0]` / global-fallback path and the Wave-4
 * filters never execute → emitted graph is byte-identical to pre-Wave-4. Derived
 * at the composition root into `PipelineConfig.callRefuseAmbiguous`; mirrors the
 * {@link isTypeEnvEnabled} reader pattern.
 */
export function isCallRefuseAmbiguousEnabled(): boolean {
  return isEnvTruthy(CALL_REFUSE_AMBIGUOUS_ENV);
}

/** Environment opt-in for the Wave 7 heritage interface-vs-class disambiguation ({@link isHeritageDisambiguationEnabled}). */
export const HERITAGE_DISAMBIGUATION_ENV = "TYPOCOP_HERITAGE_DISAMBIGUATION";

/**
 * Whether the Wave 7 (§3.1) heritage / MRO correctness disambiguation is enabled.
 * **OPT-IN — default `false`.** When `true`, gates the EDGE-CHANGING parts:
 *  (a) Phase-3 interface-vs-class disambiguation in the heritage hint loop
 *      ({@link resolveHeritageRelType} may upgrade an `inherits` hint to an
 *      `implements` edge — and vice-versa — via the symbol table first, then a
 *      C#/Java `^I[A-Z]` / Swift-protocol / others-extends heuristic),
 *  (b) the per-language tie-break rules in `computeMRO`'s collision loop
 *      (C++ leftmost-base, C#/Java/Kotlin class-method-beats-interface +
 *      2+-interface ambiguity, Rust qualified-syntax-null, default first-def),
 *  (c) the Phase-2 Go anonymous-struct-embedding + Ruby `include`/`extend`/
 *      `prepend` mixin heritage emission.
 *
 * When OFF: today's `hint.kind`-trusted heritage relType + today's
 * language-blind single-loop `computeMRO` + no Go-embedding / Ruby-mixin edges →
 * BYTE-IDENTICAL golden output. The ambiguity diagnostics (`MROResult.entries`)
 * are ADDITIVE/inert (no edge change) and stay ALWAYS-ON regardless of this flag.
 *
 * Read in BOTH Phase 2 (inside `extractSymbolsWithQueries` / the parse worker,
 * which inherit `process.env`, for the Go/Ruby emission) and the composition root
 * (to derive `PipelineConfig.heritageDisambiguation` for the Phase-3 paths) —
 * both consult this single env so the two phases agree. Mirrors the
 * {@link isTypeEnvEnabled} / {@link isFrameworkExtractionEnabled} reader pattern,
 * and is linked to {@link PARSE_VERSION} so toggling it invalidates the warm cache.
 */
export function isHeritageDisambiguationEnabled(): boolean {
  return isEnvTruthy(HERITAGE_DISAMBIGUATION_ENV);
}

/**
 * Bounded concurrency for Phase 6 embedding generation (Phase C).
 *
 * Conservative default. Local model backends (Ollama, in-process HuggingFace)
 * can become *slower* under overload, so keep this small (plan recommends 2–4
 * for local backends). The pipeline may pass an adapter-appropriate value for
 * remote/HTTP providers later; this default must stay safe for the slowest
 * (local) case. Used with {@link mapWithConcurrency} so there is never an
 * unbounded `Promise.all` over embeddings.
 */
export const EMBEDDING_CONCURRENCY = 3;

/**
 * Per-embedding timeout in milliseconds (Phase C).
 *
 * Caps a single embedding call so one slow item cannot stall the whole index.
 * On timeout the item is treated as a failure (skipped → keyword-only), not a
 * pipeline rejection. Generous enough for a cold local model to respond.
 */
export const EMBEDDING_TIMEOUT_MS = 30_000;

/**
 * Default batch size for the OPTIONAL `EmbeddingAdapter.embedTexts` fast-path
 * (embeddings performance plan, Phase 1).
 *
 * When an adapter exposes `embedTexts`, {@link buildSearchIndex} groups jobs
 * into chunks of at most this many texts and feeds the BATCHES (not individual
 * items) through {@link mapWithConcurrency} at {@link EMBEDDING_CONCURRENCY}.
 * Conservative default — very large texts can OOM at higher sizes; callers on
 * tight memory should lower it. MUST be ≥ 1.
 */
export const EMBEDDING_BATCH_SIZE = 16;

/**
 * Hard upper bound (ms) for a single batched `embedTexts` call (Phase 1).
 *
 * The per-batch timeout is `min(EMBEDDING_TIMEOUT_MS × batch.length, this cap)`,
 * so a large batch cannot wait an unbounded multiple of the per-item budget.
 * On timeout/throw the whole batch is suspect (all-or-nothing inference) and the
 * caller falls back to the per-item `embedText` + per-item timeout path exactly
 * once.
 */
export const EMBEDDING_BATCH_TIMEOUT_CAP_MS = 120_000;

/** Environment override for {@link EMBEDDING_BATCH_SIZE}. */
export const EMBEDDING_BATCH_SIZE_ENV = "EMBEDDING_BATCH_SIZE";

/**
 * Opt-in flag (env-gated): batched `embedTexts` is OFF BY DEFAULT. When set
 * truthy, callers USE `embedTexts` on adapters that support it; otherwise they
 * use the per-item `embedText` path.
 *
 * Default-off is deliberate and evidence-based: on CPU with the default model
 * (`mxbai-embed-large-v1`, fp32), batched feature-extraction pads every text in
 * a batch to the longest sequence, so variable-length code symbols make a batch
 * SLOWER than summed per-item calls (measured ~50% slower on `search`). Batching
 * is retained as opt-in for hardware/models where it helps (GPU, uniform-length
 * corpora). Recognized truthy values: "1", "true", "yes", "on" (case-insensitive).
 */
export const EMBEDDING_ENABLE_BATCH_ENV = "EMBEDDING_ENABLE_BATCH";

/**
 * Resolve the configured embedding batch size from the environment, clamped to
 * ≥ 1. Falls back to {@link EMBEDDING_BATCH_SIZE} when unset/invalid.
 */
export function getConfiguredEmbeddingBatchSize(): number {
  const raw = process.env[EMBEDDING_BATCH_SIZE_ENV];
  if (raw === undefined || raw === "") {
    return EMBEDDING_BATCH_SIZE;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return EMBEDDING_BATCH_SIZE;
  }
  return parsed;
}

/**
 * Whether the batched `embedTexts` path is enabled via
 * {@link EMBEDDING_ENABLE_BATCH_ENV}. Defaults to FALSE (per-item `embedText`);
 * batching is opt-in because it is slower on CPU for the default model.
 */
export function isEmbeddingBatchEnabled(): boolean {
  const raw = process.env[EMBEDDING_ENABLE_BATCH_ENV];
  if (raw === undefined) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/**
 * Default hard ceiling on live entries in the embedding cache (A3).
 *
 * The cache (`infrastructure/cache/embedding-cache.ts`) is pruned to the run's
 * live embed-text hashes each run, so it normally tracks the current corpus.
 * This cap is the safety bound for the transient window before pruning (and for
 * pathological corpora): once exceeded, the OLDEST entries are evicted FIFO. A
 * symbol's embed-text is small; this default comfortably covers very large
 * repos. MUST be ≥ 1.
 */
export const EMBEDDING_CACHE_MAX_ENTRIES = 200_000;

/** Environment override for {@link EMBEDDING_CACHE_MAX_ENTRIES}. */
export const EMBEDDING_CACHE_MAX_ENTRIES_ENV = "EMBEDDING_CACHE_MAX_ENTRIES";

/**
 * Opt-out flag (env-gated): the embedding cache is ON BY DEFAULT. When set
 * truthy, the orchestrator SKIPS wiring the embedding cache, so every run
 * recomputes embeddings (useful for debugging or to force a clean re-embed
 * without clearing the manifest). Recognized truthy values: "1", "true", "yes",
 * "on" (case-insensitive).
 */
export const EMBEDDING_CACHE_DISABLE_ENV = "EMBEDDING_CACHE_DISABLE";

/**
 * Resolve the configured embedding-cache entry cap from the environment, clamped
 * to ≥ 1. Falls back to {@link EMBEDDING_CACHE_MAX_ENTRIES} when unset/invalid.
 */
export function getConfiguredEmbeddingCacheMaxEntries(): number {
  const raw = process.env[EMBEDDING_CACHE_MAX_ENTRIES_ENV];
  if (raw === undefined || raw === "") {
    return EMBEDDING_CACHE_MAX_ENTRIES;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return EMBEDDING_CACHE_MAX_ENTRIES;
  }
  return parsed;
}

/**
 * Whether the embedding cache is DISABLED via {@link EMBEDDING_CACHE_DISABLE_ENV}.
 * Defaults to FALSE (cache enabled); the cache is opt-OUT, not opt-in, because a
 * warm cache only ever skips redundant work and never changes output.
 */
export function isEmbeddingCacheDisabled(): boolean {
  const raw = process.env[EMBEDDING_CACHE_DISABLE_ENV];
  if (raw === undefined) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/**
 * Bounded chunk size for batch database writes (Phase D).
 *
 * When an adapter implements the OPTIONAL batch methods
 * (`GraphAdapter.createNodes` / `createRelationships`,
 * `VectorAdapter.indexSymbols`), the indexing pipeline groups same-label /
 * same-type rows and splits them into chunks of at most this many rows per
 * call. This keeps a single write (one query or one RPC) bounded so very large
 * repos do not build an unbounded statement or payload. The metrics counts
 * (graphNodeWrites/graphEdgeWrites/vectorWrites) still reflect ROWS written,
 * not the number of batch calls.
 */
export const DB_WRITE_BATCH_SIZE = 500;

/** Default gRPC message limit for the Ladybug connection server and clients. */
export const DEFAULT_GRPC_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/**
 * Environment variable used by both client and server configuration to keep
 * gRPC message limits aligned.
 */
export const GRPC_MAX_MESSAGE_BYTES_ENV = "LADYBUG_GRPC_MAX_MESSAGE_BYTES";

/**
 * gRPC keepalive (HTTP/2 PINGs) — keep an idle channel warm through long
 * client-side compute windows (e.g. the `--pdg` PDG phase, which builds CFGs +
 * re-parses files with NO DB traffic) so a later write doesn't race a server
 * that idled/dropped the connection ("Failed to connect before the deadline").
 *
 * LOAD-BEARING PAIRING: the server's {@link GRPC_SERVER_MIN_PING_INTERVAL_MS}
 * must be <= the client's {@link GRPC_KEEPALIVE_TIME_MS}, or the server replies
 * GOAWAY("too_many_pings") and itself CAUSES the drop. 20s ping >= 10s min is safe.
 */
export const GRPC_KEEPALIVE_TIME_MS = 20_000;
/** How long the client waits for a keepalive PING ack before considering the conn dead. */
export const GRPC_KEEPALIVE_TIMEOUT_MS = 10_000;
/** Server's minimum tolerated client ping interval (must be <= GRPC_KEEPALIVE_TIME_MS). */
export const GRPC_SERVER_MIN_PING_INTERVAL_MS = 10_000;

/**
 * Safety factor for application payloads inside a protobuf message. The batch
 * JSON field should stay below the transport ceiling to leave framing overhead.
 */
export const RPC_PAYLOAD_BUDGET_RATIO = 0.75;

export function deriveRpcPayloadBudgetBytes(maxMessageBytes: number): number {
  return Math.max(1, Math.floor(maxMessageBytes * RPC_PAYLOAD_BUDGET_RATIO));
}

export const RPC_PAYLOAD_BUDGET_BYTES = deriveRpcPayloadBudgetBytes(
  DEFAULT_GRPC_MAX_MESSAGE_BYTES,
);

export function getConfiguredGrpcMaxMessageBytes(): number {
  const raw = process.env[GRPC_MAX_MESSAGE_BYTES_ENV];
  if (raw === undefined || raw === "") {
    return DEFAULT_GRPC_MAX_MESSAGE_BYTES;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${GRPC_MAX_MESSAGE_BYTES_ENV} must be an integer >= 1, received ${raw}`);
  }
  return parsed;
}

export function getRpcPayloadBudgetBytes(
  maxMessageBytes = getConfiguredGrpcMaxMessageBytes(),
): number {
  return deriveRpcPayloadBudgetBytes(maxMessageBytes);
}

/**
 * Default grace period (ms) the connection server waits for in-flight gRPC work
 * to finish during shutdown before escalating to `forceShutdown` and rejecting
 * still-pending requests. Bounds the "drain forever" hang (resilience Phase B).
 */
export const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

/**
 * Default hard deadline (ms) for the whole shutdown sequence. After this the
 * native DB close is abandoned and an unref'd backstop timer force-exits the
 * process, so shutdown can never wedge indefinitely (resilience Phase B).
 */
export const DEFAULT_SHUTDOWN_HARD_MS = 10_000;

/** Environment override for {@link DEFAULT_SHUTDOWN_GRACE_MS}. */
export const SHUTDOWN_GRACE_MS_ENV = "LADYBUG_SERVER_SHUTDOWN_GRACE_MS";

/** Environment override for {@link DEFAULT_SHUTDOWN_HARD_MS}. */
export const SHUTDOWN_HARD_MS_ENV = "LADYBUG_SERVER_SHUTDOWN_HARD_MS";

function getConfiguredPositiveIntEnv(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${envName} must be an integer >= 1, received ${raw}`);
  }
  return parsed;
}

/**
 * Default `stale` window (ms) for the database file lock (`proper-lockfile`).
 * After a process holding the lock dies without releasing it, the lock is
 * considered stale and self-clears after this window, so a restart after a
 * crash is not blocked indefinitely (resilience Phase D). Lowering this trades
 * faster crash-recovery for a higher chance of two processes briefly believing
 * they hold the DB — keep a safety margin.
 */
export const DEFAULT_DB_LOCK_STALE_MS = 30_000;

/**
 * Default number of retries `proper-lockfile` performs (with exponential
 * backoff) while waiting to acquire the database file lock (resilience Phase D).
 */
export const DEFAULT_DB_LOCK_RETRIES = 10;

/** Environment override for {@link DEFAULT_DB_LOCK_STALE_MS}. */
export const DB_LOCK_STALE_MS_ENV = "LADYBUG_DB_LOCK_STALE_MS";

/** Environment override for {@link DEFAULT_DB_LOCK_RETRIES}. */
export const DB_LOCK_RETRIES_ENV = "LADYBUG_DB_LOCK_RETRIES";

export function getConfiguredDbLockStaleMs(): number {
  return getConfiguredPositiveIntEnv(DB_LOCK_STALE_MS_ENV, DEFAULT_DB_LOCK_STALE_MS);
}

export function getConfiguredDbLockRetries(): number {
  // proper-lockfile accepts retries >= 0; 0 means "try once".
  const raw = process.env[DB_LOCK_RETRIES_ENV];
  if (raw === undefined || raw === "") {
    return DEFAULT_DB_LOCK_RETRIES;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${DB_LOCK_RETRIES_ENV} must be an integer >= 0, received ${raw}`);
  }
  return parsed;
}

/**
 * A conservative initial page size for full-graph export reads. The reader can
 * halve this on RESOURCE_EXHAUSTED, so this is a throughput default rather than
 * a correctness boundary.
 */
export function deriveExportGraphReadPageSize(maxMessageBytes: number): number {
  return Math.max(1, Math.floor(deriveRpcPayloadBudgetBytes(maxMessageBytes) / 64_000));
}

export const EXPORT_GRAPH_READ_PAGE_SIZE = deriveExportGraphReadPageSize(
  DEFAULT_GRPC_MAX_MESSAGE_BYTES,
);

export function getExportGraphReadPageSize(
  maxMessageBytes = getConfiguredGrpcMaxMessageBytes(),
): number {
  return deriveExportGraphReadPageSize(maxMessageBytes);
}

/** Per-entity secondary row-count caps for batch persistence. */
export const DB_NODE_WRITE_BATCH_SIZE = 250;
export const DB_RELATIONSHIP_WRITE_BATCH_SIZE = DB_WRITE_BATCH_SIZE;
export const DB_VECTOR_WRITE_BATCH_SIZE = 200;

/**
 * Maximum number of traced entry points for Phase 5 process tracing (Phase F).
 *
 * Process tracing scales with the number of entry points: every entry point
 * seeds a depth-first traversal of the call graph. On very large repos this can
 * produce an excessive number of traces. This cap limits how many entry points
 * (highest-scoring first) are traced.
 *
 * DEFAULT is `Infinity` — i.e. UNLIMITED, preserving current behavior exactly.
 * Wiring exists so a caller (or a future benchmark-driven default) can clamp the
 * count without changing the scoring or ordering of entry points. Do not lower
 * the default without a benchmark demonstrating the need (plan Phase F).
 */
export const MAX_ENTRY_POINTS = Infinity;

/** Maximum number of nodes in the knowledge graph (Req 23.2) */
export const MAX_GRAPH_SIZE_NODES = 500_000;

/** Query execution timeout in milliseconds (Req 23.3) */
export const QUERY_TIMEOUT_MS = 2_000;

/** Maximum graph traversal depth to prevent infinite loops (Req 23.4, 16.7) */
export const MAX_TRAVERSAL_DEPTH = 20;

/** POSIX and common C++ standard library headers treated as internal/system headers. */
export const C_SYSTEM_HEADERS: ReadonlySet<string> = new Set([
  "algorithm", "array", "atomic", "bitset", "cassert", "cctype", "cerrno",
  "cfenv", "cfloat", "charconv", "chrono", "cinttypes", "climits", "clocale",
  "cmath", "codecvt", "compare", "complex", "concepts", "condition_variable",
  "coroutine", "csetjmp", "csignal", "cstdarg", "cstddef", "cstdint",
  "cstdio", "cstdlib", "cstring", "ctgmath", "ctime", "cuchar", "cwchar",
  "cwctype", "deque", "exception", "execution", "expected", "filesystem",
  "format", "forward_list", "fstream", "functional", "future", "initializer_list",
  "iomanip", "ios", "iosfwd", "iostream", "istream", "iterator", "latch",
  "limits", "list", "locale", "map", "memory", "memory_resource", "mutex",
  "new", "numbers", "numeric", "optional", "ostream", "queue", "random",
  "ranges", "ratio", "regex", "scoped_allocator", "semaphore", "set",
  "shared_mutex", "source_location", "span", "sstream", "stack", "stdexcept",
  "stdfloat", "stop_token", "streambuf", "string", "string_view", "strstream",
  "syncstream", "system_error", "thread", "tuple", "type_traits", "typeindex",
  "typeinfo", "unordered_map", "unordered_set", "utility", "valarray", "variant",
  "vector", "version", "cassert", "complex.h", "ctype.h", "errno.h", "fenv.h",
  "float.h", "inttypes.h", "iso646.h", "limits.h", "locale.h", "math.h",
  "setjmp.h", "signal.h", "stdalign.h", "stdarg.h", "stdatomic.h", "stdbool.h",
  "stddef.h", "stdint.h", "stdio.h", "stdlib.h", "stdnoreturn.h", "string.h",
  "tgmath.h", "threads.h", "time.h", "uchar.h", "wchar.h", "wctype.h",
]);

/** Common VCS hosts used to identify Go module import roots. */
export const GO_VCS_HOSTS: ReadonlySet<string> = new Set([
  "bitbucket.org",
  "codeberg.org",
  "git.sr.ht",
  "github.com",
  "gitlab.com",
  "golang.org",
]);

/**
 * Validates if a file size is within the allowed limit.
 * 
 * @param sizeBytes - File size in bytes
 * @returns true if file size is within limit, false otherwise
 */
export function isFileSizeValid(sizeBytes: number): boolean {
  return sizeBytes > 0 && sizeBytes <= MAX_FILE_SIZE_BYTES;
}

/**
 * Validates if a graph size is within the allowed limit.
 * 
 * @param nodeCount - Number of nodes in the graph
 * @returns true if graph size is within limit, false otherwise
 */
export function isGraphSizeValid(nodeCount: number): boolean {
  return nodeCount >= 0 && nodeCount <= MAX_GRAPH_SIZE_NODES;
}

/**
 * Creates a timeout promise that rejects after the specified duration.
 * Used to enforce query timeout limits.
 * 
 * @param timeoutMs - Timeout duration in milliseconds (defaults to QUERY_TIMEOUT_MS)
 * @returns Promise that rejects with a timeout error
 */
export function createQueryTimeout(timeoutMs: number = QUERY_TIMEOUT_MS): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Query execution exceeded timeout of ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

/**
 * Wraps a query execution with a timeout limit.
 * 
 * @param queryFn - The async query function to execute
 * @param timeoutMs - Timeout duration in milliseconds (defaults to QUERY_TIMEOUT_MS)
 * @returns Promise that resolves with query result or rejects on timeout
 * 
 * @example
 * ```typescript
 * const result = await withQueryTimeout(
 *   async () => executeComplexQuery(params),
 *   2000
 * );
 * ```
 */
export async function withQueryTimeout<T>(
  queryFn: () => Promise<T>,
  timeoutMs: number = QUERY_TIMEOUT_MS
): Promise<T> {
  return Promise.race([
    queryFn(),
    createQueryTimeout(timeoutMs)
  ]);
}

/**
 * Run an async operation with a timeout that resolves to a SENTINEL instead of
 * rejecting when it elapses.
 *
 * Unlike {@link withQueryTimeout} (which rejects on timeout), this is the
 * failure-tolerant variant used by embedding generation: a slow item must not
 * reject the surrounding batch. If `fn()` itself rejects, this still rejects —
 * callers that need full tolerance should also catch their own throws (the
 * embedding path does both: catch + this timeout).
 *
 * The timer is always cleared so a slow-but-eventually-resolving operation does
 * not leak a pending timer or keep the event loop alive.
 *
 * @param fn        - The async operation to run.
 * @param timeoutMs - Timeout in milliseconds.
 * @param onTimeout - Value (or factory) returned when the timeout elapses first.
 * @returns The operation's result, or the timeout sentinel if it elapses first.
 */
export async function withTimeoutOr<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  onTimeout: T | (() => T),
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const TIMED_OUT = Symbol("timed-out");
  // Hold the operation promise so we can both race it AND attach a guard handler.
  // If the timeout wins the race and `fn()` LATER rejects, that rejection would
  // otherwise be unhandled (the race already settled), emitting a Node
  // unhandledRejection warning. The guard swallows the late rejection. A
  // rejection that arrives BEFORE the timeout is still observed by the race
  // below, so this preserves the "rejects if fn() rejects" contract.
  const operation = fn();
  void operation.catch(() => {});
  try {
    const result = await Promise.race<T | typeof TIMED_OUT>([
      operation,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
    if (result === TIMED_OUT) {
      return typeof onTimeout === "function" ? (onTimeout as () => T)() : onTimeout;
    }
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Validates if a traversal depth is within the allowed limit.
 * 
 * @param depth - Current traversal depth
 * @returns true if depth is within limit, false otherwise
 */
export function isTraversalDepthValid(depth: number): boolean {
  return depth >= 0 && depth <= MAX_TRAVERSAL_DEPTH;
}
