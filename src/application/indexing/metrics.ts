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
  | "resolution"
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

  /** Total lines of source scanned, if known (0/undefined = unknown). */
  readonly totalLines: number;
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
  | "totalLines";

/** Accumulating elapsed-millisecond fields. */
type ElapsedField = "embeddingElapsedMs";

const PHASE_NAMES: readonly PhaseName[] = [
  "structure",
  "parsing",
  "resolution",
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
    resolution: 0,
    clustering: 0,
    processes: 0,
    search: 0,
    persist: 0,
  };
  const phaseStarts = new Map<PhaseName, number>();

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
    totalLines: 0,
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
    },

    endPhase(name: PhaseName): void {
      const start = phaseStarts.get(name);
      if (start === undefined) return;
      phases[name] += performance.now() - start;
      phaseStarts.delete(name);
    },

    async time<T>(name: PhaseName, fn: () => Promise<T>): Promise<T> {
      const start = markStart();
      try {
        return await fn();
      } finally {
        phases[name] += performance.now() - start;
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

    finalize(): IndexingMetrics {
      const totalMs = firstStart === null ? 0 : performance.now() - firstStart;
      return {
        phases: { ...phases },
        totalMs,
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
        totalLines: counts.totalLines,
      };
    },
  };
}

/**
 * Render a concise, multi-line throughput summary suitable for stderr.
 *
 * Approximate LOC/s is included only when `totalLines` and `totalMs` are both
 * positive; otherwise it is omitted (no divide-by-zero, no misleading "0 LOC/s").
 */
export function formatMetrics(metrics: IndexingMetrics): string {
  const ms = (n: number): string => `${n.toFixed(1)}ms`;
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

  if (metrics.totalLines > 0 && metrics.totalMs > 0) {
    const locPerSec = (metrics.totalLines / metrics.totalMs) * 1000;
    lines.push(`  throughput:   ${Math.round(locPerSec)} LOC/s (${metrics.totalLines} lines)`);
  }

  return lines.join("\n");
}
