/**
 * Indexing metrics — an internal, dependency-free timing/counting layer.
 *
 * Wraps {@link runIndexingPipeline} to make the cost of each phase measurable
 * without changing pipeline behavior. All measurement is local; no source code
 * or symbol text is ever sent to an external service.
 *
 * Timing uses a monotonic clock (`performance.now()`) so wall-clock adjustments
 * cannot produce negative or jittery elapsed values.
 *
 * Requirements: Phase A (instrument before optimizing).
 */

/** The pipeline phases that are individually timed. */
export type PhaseName =
  | "structure"
  | "parsing"
  // Wave 3 (Tier B): the per-file AST type-env walk. It currently runs INSIDE the
  // `parsing` phase (within `extractSymbolsWithQueries`, reusing the live tree),
  // so this slot stays 0 until/unless the env is hoisted into a top-level pass.
  // Declared here so the phase exists in the closed `Record<PhaseName,...>` enum.
  | "typeEnv"
  | "resolution"
  // Wave 5: the post-resolution data-touch detection + flow-assembly pass. Runs
  // between resolution and clustering when `PipelineConfig.dataTouch` is on; stays
  // 0 when the flag is off (the pass never runs). Declared here so the phase
  // exists in the closed `Record<PhaseName,...>` enum (the pass itself is wired in
  // a later stage).
  | "dataTouch"
  // Plan E (source task #7): the post-resolution PDG + taint pass. Runs between
  // resolution and clustering when `PipelineConfig.pdg` is on; stays 0 when off.
  | "pdg"
  | "clustering"
  | "processes"
  | "search"
  | "persist";

/**
 * Snapshot of timings and counts gathered during a single pipeline run.
 *
 * Elapsed values are milliseconds measured on a monotonic clock. Counts are
 * whatever was observed; phases that did not run leave their elapsed value at 0.
 */
export interface IndexingMetrics {
  /** Per-phase elapsed milliseconds. */
  readonly phases: Readonly<Record<PhaseName, number>>;
  /** Total elapsed milliseconds across the whole pipeline. */
  readonly totalMs: number;

  // ── Memory (B3): peak RSS high-water marks ──
  // Sampled from `process.memoryUsage().rss` at phase boundaries (phase start
  // and end). Bytes only — never source code or symbol text. These make the
  // "should we stream graph emit?" question data-driven (B3 plan): true CSV/COPY
  // streaming is only worth it if a real repo shows node/edge arrays (not the
  // already-streamed vectors) are the binding constraint.
  /**
   * Highest `rss` byte value observed at ANY phase boundary across the whole
   * run — a monotonic high-water mark, always `>= max(phaseRssBytes)`.
   */
  readonly peakRssBytes: number;
  /**
   * Per-phase RSS high-water: the largest `rss` byte value sampled at that
   * phase's boundaries (start and end). A phase that never ran samples nothing
   * and stays 0.
   */
  readonly phaseRssBytes: Readonly<Record<PhaseName, number>>;

  // ── Phase 1: structure ──
  readonly filesScanned: number;

  // ── Phase 2: parsing ──
  readonly filesParsed: number;
  readonly skippedFiles: number;
  readonly symbolCount: number;
  readonly hintCount: number;

  // ── Phase 3: resolution ──
  readonly relationshipCount: number;
  readonly externalDependencyCount: number;

  // ── Phase 4: clustering ──
  readonly clusterCount: number;

  // ── Phase 5: processes ──
  readonly processCount: number;

  // ── Phase 6: search / persist ──
  readonly graphNodeWrites: number;
  readonly graphEdgeWrites: number;
  readonly vectorWrites: number;
  readonly embeddingCount: number;
  /** Embedding items attempted (symbols + clusters) when embeddings are enabled. */
  readonly embeddingAttempts: number;
  /** Embedding items that yielded no usable embedding (null/timeout/error). */
  readonly embeddingFailures: number;
  readonly embeddingElapsedMs: number;

  // ── Batch-level persistence counters (Phase B) ──
  // These count BATCH CALLS (and split/oversized events), distinct from the
  // per-ROW counts above. They make a "many tiny retries" run legible from
  // metrics alone instead of only via console.warn. Counts/timings only — never
  // source code or embedding text.
  /** Vector batch CALLS made on the batch fast-path (not rows). */
  readonly vectorBatchCount: number;
  /** Node batch CALLS made on the batch fast-path (not rows). */
  readonly nodeBatchCount: number;
  /** Relationship batch CALLS made on the batch fast-path (not rows). */
  readonly relationshipBatchCount: number;
  /** Adaptive-split events (each RESOURCE_EXHAUSTED halving in writeWithAdaptiveSplit). */
  readonly adaptiveSplitCount: number;
  /** Oversized rows routed alone by chunkByBudget's onOversizedItem hook. */
  readonly oversizedRowCount: number;

  // ── Wave 5: data-touch pass counters ──
  // Both stay 0 unless the (default-off) data-touch pass runs. Counts only —
  // never source code or symbol text.
  /** Data-touch edges emitted (readsFromDb/writesToDb/handlesRoute/…). */
  readonly dataTouchEdgeCount: number;
  /** Synthetic Symbols minted by the data-touch pass (dbmodel:/apiendpoint:). */
  readonly syntheticSymbolCount: number;

  // ── Plan E (source task #7): PDG/taint pass counters ──
  // Both stay 0 unless the (default-off) `--pdg` pass runs. Counts only.
  /** BasicBlocks emitted by the PDG pass. */
  readonly pdgBlockCount: number;
  /** TaintFindings emitted by the PDG/taint solver. */
  readonly pdgFindingCount: number;
}

/**
 * A tiny mutable collector for assembling an {@link IndexingMetrics} snapshot.
 *
 * Usage:
 * ```ts
 * const m = createMetricsCollector();
 * const result = await m.time("parsing", () => extractAllSymbols(...));
 * m.set("symbolCount", result.symbols.length);
 * m.incr("graphNodeWrites");
 * const snapshot = m.finalize();
 * ```
 */
export interface MetricsCollector {
  /** Begin timing a phase. Pair with {@link endPhase}. */
  startPhase(name: PhaseName): void;
  /** Stop timing a phase, accumulating elapsed milliseconds. */
  endPhase(name: PhaseName): void;
  /** Time an async operation, recording its elapsed time under `name`. */
  time<T>(name: PhaseName, fn: () => Promise<T>): Promise<T>;
  /** Set a scalar count to an absolute value. */
  set(field: CountField, value: number): void;
  /** Increment a scalar count by `by` (default 1). */
  incr(field: CountField, by?: number): void;
  /** Add an already-measured elapsed-millisecond value to a timing field. */
  addElapsed(field: ElapsedField, ms: number): void;
  /**
   * Sample `process.memoryUsage().rss` and fold it into both the global
   * `peakRssBytes` high-water and the named phase's high-water. Called at phase
   * boundaries (start/end). Sampling outside a phase still advances the global
   * peak; pass a phase name to also advance that phase's high-water. Cheap and
   * synchronous; safe to call repeatedly.
   */
  sampleMemory(phase?: PhaseName): void;
  /** Produce the immutable snapshot (also fills in totalMs from first start). */
  finalize(): IndexingMetrics;
}

/** Scalar count fields settable/incrementable on the collector. */
type CountField =
  | "filesScanned"
  | "filesParsed"
  | "skippedFiles"
  | "symbolCount"
  | "hintCount"
  | "relationshipCount"
  | "externalDependencyCount"
  | "clusterCount"
  | "processCount"
  | "graphNodeWrites"
  | "graphEdgeWrites"
  | "vectorWrites"
  | "embeddingCount"
  | "embeddingAttempts"
  | "embeddingFailures"
  | "vectorBatchCount"
  | "nodeBatchCount"
  | "relationshipBatchCount"
  | "adaptiveSplitCount"
  | "oversizedRowCount"
  // Wave 5 data-touch counters. Stay 0 when the pass is off (flag default).
  | "dataTouchEdgeCount"
  | "syntheticSymbolCount"
  // Plan E PDG/taint counters. Stay 0 when the `--pdg` pass is off (flag default).
  | "pdgBlockCount"
  | "pdgFindingCount";

/** Accumulating elapsed-millisecond fields. */
type ElapsedField = "embeddingElapsedMs";

const PHASE_NAMES: readonly PhaseName[] = [
  "structure",
  "parsing",
  "typeEnv",
  "resolution",
  "dataTouch",
  "pdg",
  "clustering",
  "processes",
  "search",
  "persist",
];

/**
 * Create a fresh, mutable metrics collector. Dependency-free; uses a monotonic
 * clock so elapsed values are never negative.
 */
export function createMetricsCollector(): MetricsCollector {
  const phases: Record<PhaseName, number> = {
    structure: 0,
    parsing: 0,
    typeEnv: 0,
    resolution: 0,
    dataTouch: 0,
    pdg: 0,
    clustering: 0,
    processes: 0,
    search: 0,
    persist: 0,
  };
  const phaseStarts = new Map<PhaseName, number>();

  // B3: RSS high-water tracking. `peakRssBytes` is a monotonic global maximum;
  // `phaseRss` holds each phase's own high-water (max rss sampled at its
  // boundaries). Sampling is `process.memoryUsage().rss` — bytes only.
  const phaseRss: Record<PhaseName, number> = {
    structure: 0,
    parsing: 0,
    typeEnv: 0,
    resolution: 0,
    dataTouch: 0,
    pdg: 0,
    clustering: 0,
    processes: 0,
    search: 0,
    persist: 0,
  };
  let peakRssBytes = 0;

  const sampleMemory = (phase?: PhaseName): void => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRssBytes) peakRssBytes = rss;
    if (phase !== undefined && rss > phaseRss[phase]) phaseRss[phase] = rss;
  };

  const counts: Record<CountField, number> = {
    filesScanned: 0,
    filesParsed: 0,
    skippedFiles: 0,
    symbolCount: 0,
    hintCount: 0,
    relationshipCount: 0,
    externalDependencyCount: 0,
    clusterCount: 0,
    processCount: 0,
    graphNodeWrites: 0,
    graphEdgeWrites: 0,
    vectorWrites: 0,
    embeddingCount: 0,
    embeddingAttempts: 0,
    embeddingFailures: 0,
    vectorBatchCount: 0,
    nodeBatchCount: 0,
    relationshipBatchCount: 0,
    adaptiveSplitCount: 0,
    oversizedRowCount: 0,
    dataTouchEdgeCount: 0,
    syntheticSymbolCount: 0,
    pdgBlockCount: 0,
    pdgFindingCount: 0,
  };

  const elapsed: Record<ElapsedField, number> = {
    embeddingElapsedMs: 0,
  };

  let firstStart: number | null = null;

  const markStart = (): number => {
    const now = performance.now();
    if (firstStart === null) firstStart = now;
    return now;
  };

  return {
    startPhase(name: PhaseName): void {
      phaseStarts.set(name, markStart());
      sampleMemory(name);
    },

    endPhase(name: PhaseName): void {
      const start = phaseStarts.get(name);
      if (start === undefined) return;
      phases[name] += performance.now() - start;
      phaseStarts.delete(name);
      sampleMemory(name);
    },

    async time<T>(name: PhaseName, fn: () => Promise<T>): Promise<T> {
      const start = markStart();
      sampleMemory(name);
      try {
        return await fn();
      } finally {
        phases[name] += performance.now() - start;
        sampleMemory(name);
      }
    },

    set(field: CountField, value: number): void {
      counts[field] = value;
    },

    incr(field: CountField, by = 1): void {
      counts[field] += by;
    },

    addElapsed(field: ElapsedField, ms: number): void {
      elapsed[field] += ms;
    },

    sampleMemory,

    finalize(): IndexingMetrics {
      const totalMs = firstStart === null ? 0 : performance.now() - firstStart;
      // Final sample so the global peak reflects end-of-run memory even if the
      // last activity happened outside a timed phase.
      sampleMemory();
      return {
        phases: { ...phases },
        totalMs,
        peakRssBytes,
        phaseRssBytes: { ...phaseRss },
        filesScanned: counts.filesScanned,
        filesParsed: counts.filesParsed,
        skippedFiles: counts.skippedFiles,
        symbolCount: counts.symbolCount,
        hintCount: counts.hintCount,
        relationshipCount: counts.relationshipCount,
        externalDependencyCount: counts.externalDependencyCount,
        clusterCount: counts.clusterCount,
        processCount: counts.processCount,
        graphNodeWrites: counts.graphNodeWrites,
        graphEdgeWrites: counts.graphEdgeWrites,
        vectorWrites: counts.vectorWrites,
        embeddingCount: counts.embeddingCount,
        embeddingAttempts: counts.embeddingAttempts,
        embeddingFailures: counts.embeddingFailures,
        embeddingElapsedMs: elapsed.embeddingElapsedMs,
        vectorBatchCount: counts.vectorBatchCount,
        nodeBatchCount: counts.nodeBatchCount,
        relationshipBatchCount: counts.relationshipBatchCount,
        adaptiveSplitCount: counts.adaptiveSplitCount,
        oversizedRowCount: counts.oversizedRowCount,
        dataTouchEdgeCount: counts.dataTouchEdgeCount,
        syntheticSymbolCount: counts.syntheticSymbolCount,
        pdgBlockCount: counts.pdgBlockCount,
        pdgFindingCount: counts.pdgFindingCount,
      };
    },
  };
}

/**
 * Render a concise, multi-line throughput summary suitable for stderr.
 *
 * The batch/split summary line is VERBOSE-ONLY (it is rendered by the verbose
 * pipeline path); the rest of the summary is unchanged from prior behavior so
 * existing non-verbose output stays byte-identical.
 */
export function formatMetrics(metrics: IndexingMetrics): string {
  const ms = (n: number): string => `${n.toFixed(1)}ms`;
  const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
  const lines: string[] = [];

  lines.push("[pipeline] Indexing metrics:");
  lines.push(`  total:        ${ms(metrics.totalMs)}`);
  for (const name of PHASE_NAMES) {
    lines.push(`  ${(name + ":").padEnd(13)} ${ms(metrics.phases[name])}`);
  }
  lines.push(
    `  files:        ${metrics.filesParsed} parsed / ${metrics.filesScanned} scanned` +
      ` (${metrics.skippedFiles} skipped)`,
  );
  lines.push(
    `  graph:        ${metrics.symbolCount} symbols, ${metrics.hintCount} hints,` +
      ` ${metrics.relationshipCount} relationships, ${metrics.externalDependencyCount} ext deps`,
  );
  lines.push(
    `  structure:    ${metrics.clusterCount} clusters, ${metrics.processCount} processes`,
  );
  lines.push(
    `  writes:       ${metrics.graphNodeWrites} nodes, ${metrics.graphEdgeWrites} edges,` +
      ` ${metrics.vectorWrites} vectors`,
  );
  lines.push(
    `  embeddings:   ${metrics.embeddingCount} in ${ms(metrics.embeddingElapsedMs)}` +
      ` (${metrics.embeddingAttempts} attempted, ${metrics.embeddingFailures} failed)`,
  );
  lines.push(
    `  batches:      ${metrics.nodeBatchCount} node, ${metrics.relationshipBatchCount} rel,` +
      ` ${metrics.vectorBatchCount} vector` +
      ` (${metrics.adaptiveSplitCount} splits, ${metrics.oversizedRowCount} oversized)`,
  );
  // B3: peak RSS + the phase that held the high-water, so the streaming question
  // is data-driven. `peakRssBytes` is the monotonic global maximum.
  const peakPhase = PHASE_NAMES.reduce<PhaseName>(
    (top, name) => (metrics.phaseRssBytes[name] > metrics.phaseRssBytes[top] ? name : top),
    PHASE_NAMES[0],
  );
  lines.push(
    `  memory:       peak RSS ${mib(metrics.peakRssBytes)}` +
      ` (high-water in ${peakPhase}: ${mib(metrics.phaseRssBytes[peakPhase])})`,
  );

  return lines.join("\n");
}
