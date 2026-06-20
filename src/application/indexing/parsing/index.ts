/**
 * Phase 2: Symbol extraction from ASTs.
 *
 * Processes all FileNodes, parses each file, and extracts Symbol objects
 * with deterministic IDs plus raw relationship hints for Phase 3.
 *
 * Requirements: 3.2, 4.1, 4.2
 */
import type { Symbol } from "../../../core/domain.js";
import type { FileNode } from "../structure/index.js";
import type { RawRelationshipHint } from "../../../infrastructure/parsing/extract-symbols.js";
import {
  runParseTask,
  parseWorkerEntryPath,
} from "../../../infrastructure/parsing/parse-worker.js";
import {
  isParseSkipped,
  type ParseTask,
  type ParseTaskResult,
} from "../../../infrastructure/parsing/parse-worker-protocol.js";
import Parser from "tree-sitter";
import * as path from "path";
import {
  PARSE_CONCURRENCY,
  getConfiguredParseThreads,
  getConfiguredParseWorkerThreshold,
  isParseWorkersEnabled,
} from "../../../platform/utils/limits.js";
import { WorkerPool, type WorkerPoolRunResult } from "../../../platform/utils/worker-pool.js";

export type { RawRelationshipHint } from "../../../infrastructure/parsing/extract-symbols.js";

/** Combined output of Phase 2 */
export interface ParsingResult {
  readonly symbols: Symbol[];
  readonly hints: RawRelationshipHint[];
  readonly skippedFiles: number;
}

/**
 * Options for {@link extractAllSymbols} (B5/B6).
 *
 * @property concurrency - Size of the bounded parsing worker pool. Defaults to
 *   {@link PARSE_CONCURRENCY}.
 * @property onProgress  - Completion hook invoked exactly ONCE per file as it
 *   settles (including skipped files), so `done` always reaches `total`. This is
 *   the SHARED per-file completion point for both the progress renderer (PR5)
 *   and the metrics layer — wire observation here rather than instrumenting the
 *   loop twice. `done` is an order-independent shared-counter bump under
 *   concurrency; `currentPath` is the file that just settled.
 */
export interface ExtractAllSymbolsOptions {
  readonly concurrency?: number;
  readonly onProgress?: (done: number, total: number, currentPath?: string) => void;
  /**
   * Worker-thread pool controls (B1). All optional; defaults preserve today's
   * behaviour. Above {@link getConfiguredParseWorkerThreshold} files (and when
   * `useWorkerThreads !== false`) parsing runs on a `worker_threads` pool;
   * otherwise it uses the in-process async path.
   *
   * @property useWorkerThreads - Force-disable (`false`) the pool regardless of
   *   file count — used by the incremental small-subset path and tests.
   * @property workerThreshold  - Override the file-count threshold (tests force
   *   the pool on with a tiny corpus by passing `1`).
   * @property parseThreads     - Override the worker count.
   * @property poolFactory      - Test seam: inject an in-process {@link ParsePool}
   *   that runs the SAME per-file logic, so determinism/crash/breaker behaviour is
   *   testable under vitest without a loadable `.ts` worker entry.
   */
  readonly useWorkerThreads?: boolean;
  readonly workerThreshold?: number;
  readonly parseThreads?: number;
  readonly poolFactory?: ParsePoolFactory;
}

// ─── Symbol ID generation ─────────────────────────────────────────────────────

/**
 * Canonical symbol-ID generator (B4). Re-exported from the infrastructure layer
 * so this application module and existing importers keep resolving it, while the
 * query path (also in infrastructure) shares the SAME implementation without a
 * layering violation. Both paths now emit column-inclusive, comparable IDs.
 */
export { generateSymbolId } from "../../../infrastructure/parsing/symbol-id.js";

// ─── Deduplication ────────────────────────────────────────────────────────────

function deduplicateById(symbols: Symbol[]): Symbol[] {
  const seen = new Set<string>();
  const result: Symbol[] = [];
  for (const sym of symbols) {
    if (!seen.has(sym.id)) {
      seen.add(sym.id);
      result.push(sym);
    }
  }
  return result;
}

// ─── Phase 2 entry point ──────────────────────────────────────────────────────

/** Per-file extraction output collected into an original-position slot. */
interface FileSlot {
  symbols: Symbol[];
  hints: RawRelationshipHint[];
  /**
   * sha256 of the file's UTF-8 content (A2). Derived from the SAME content
   * `parseSourceFile` already read — no second `fs.readFile`. `undefined` when
   * the file took the size-skip path inside `parseSourceFile` (never read).
   */
  contentHash?: string;
}

/**
 * Per-file Phase-2 result, keyed by relPath (A2). Carries the content hash so
 * the parse cache can store `relPath → { contentHash, symbols, hints }` without
 * re-reading the file. Skipped files (parser-init failure / ParseError) are
 * absent from the map.
 */
export interface PerFileParseResult {
  readonly symbols: Symbol[];
  readonly hints: RawRelationshipHint[];
  readonly contentHash: string;
}

/** {@link extractAllSymbols} output extended with the per-file map (A2). */
export interface ParsingResultWithPerFile extends ParsingResult {
  /** relPath → that file's symbols/hints/contentHash. Skipped files are absent. */
  readonly perFile: Map<string, PerFileParseResult>;
}

/**
 * Build the PLAIN, structured-cloneable parse task for one file. The worker (or
 * the in-process fallback) needs the ABSOLUTE path to read and the RELATIVE path
 * to stamp onto symbols/hints — both computed here so the two code paths agree.
 */
function buildTask(fileNode: FileNode, index: number, relativeBase: string): ParseTask {
  return {
    index,
    filePath: path.resolve(relativeBase, fileNode.path),
    relativePath: fileNode.path,
    language: fileNode.language,
    size: fileNode.size,
  };
}

/** Convert a worker/in-process {@link ParseTaskResult} into an ordered slot. */
function resultToSlot(result: ParseTaskResult): FileSlot | null {
  if (isParseSkipped(result)) return null;
  return { symbols: result.symbols, hints: result.hints, contentHash: result.contentHash };
}

/**
 * Process a single file with a caller-owned parser cache via the shared
 * {@link runParseTask} logic (B1).
 *
 * The `parsers` map is NEVER shared with another concurrent slot, so a
 * tree-sitter `Parser` is never used by two in-flight parses at once (Risk
 * Notes). Parsers are still reused WITHIN a slot across files of the same
 * variant. Returns null when the file is skipped (parser-init failure or
 * ParseError); the caller bumps `skippedFiles`.
 */
async function processFile(
  fileNode: FileNode,
  index: number,
  relativeBase: string,
  parsers: Map<string, Parser>,
): Promise<FileSlot | null> {
  const result = await runParseTask(buildTask(fileNode, index, relativeBase), parsers);
  return resultToSlot(result);
}

/**
 * Pluggable parse-pool used by the worker-thread branch (B1).
 *
 * Production wires {@link createWorkerThreadPool} (real `worker_threads`). Tests
 * inject an IN-PROCESS pool that drives the SAME {@link runParseTask} logic with
 * injected delays / crash files, so the determinism + crash-isolation + breaker
 * behaviour is exercised under vitest (where a `.ts` worker entry cannot be
 * loaded natively) without diverging from the shipped per-file logic.
 */
export interface ParsePool {
  run(
    tasks: readonly ParseTask[],
    onSettled?: (index: number) => void,
  ): Promise<WorkerPoolRunResult<ParseTaskResult>>;
  destroy(): Promise<void>;
}

/** Factory the orchestrator calls to build a pool of `size` workers. */
export type ParsePoolFactory = (size: number) => ParsePool;

/** Real `worker_threads` pool over {@link parseWorkerEntryPath}. */
function createWorkerThreadPool(size: number): ParsePool {
  const pool = new WorkerPool<ParseTask, ParseTaskResult>({
    size,
    workerEntry: parseWorkerEntryPath(),
    // Inherit the parent's flags so a custom loader (if any) is available to the
    // worker; harmless when there is none.
    execArgv: process.execArgv,
  });
  return {
    run: (tasks, onSettled) => pool.run(tasks, onSettled),
    destroy: () => pool.destroy(),
  };
}

/**
 * In-process async-pool parse (today's exact path, B5). N logical workers pull
 * file indices off a shared counter, each with its OWN parser cache. Writes
 * results into `slots` by original index and fires `reportSettled` exactly once
 * per file (incl. skips).
 */
async function runInProcess(
  fileNodes: FileNode[],
  relativeBase: string,
  slots: (FileSlot | null)[],
  concurrency: number,
  reportSettled: (index: number) => void,
): Promise<void> {
  const total = fileNodes.length;
  let nextIndex = 0;
  async function worker(): Promise<void> {
    const parsers = new Map<string, Parser>();
    for (;;) {
      const i = nextIndex++;
      if (i >= total) return;
      slots[i] = await processFile(fileNodes[i], i, relativeBase, parsers);
      reportSettled(i);
    }
  }
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(concurrency, total); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

/**
 * Worker-thread parse (B1). Dispatches one task per file to the resilient pool;
 * each settled result is slotted by ORIGINAL index. The pool fires `reportSettled`
 * exactly once per task — including any task it abandons when the circuit breaker
 * trips — so `done` reaches `total` from the pool alone.
 *
 * On `breakerTripped` the un-parsed files (the pool's `failedIndices` that still
 * have no symbols) are finished via the IN-PROCESS path so indexing never aborts;
 * those fills do NOT re-fire progress (the pool already counted them). The pool is
 * always destroyed in a `finally`.
 */
async function runViaWorkerPool(
  fileNodes: FileNode[],
  relativeBase: string,
  slots: (FileSlot | null)[],
  reportSettled: (index: number) => void,
  options: ExtractAllSymbolsOptions,
): Promise<void> {
  const size = Math.max(1, options.parseThreads ?? getConfiguredParseThreads());
  const factory = options.poolFactory ?? createWorkerThreadPool;
  const pool = factory(size);

  const tasks: ParseTask[] = fileNodes.map((fileNode, index) =>
    buildTask(fileNode, index, relativeBase),
  );

  let breakerTripped = false;
  let failedIndices: number[] = [];
  try {
    const outcome = await pool.run(tasks, reportSettled);
    breakerTripped = outcome.breakerTripped;
    failedIndices = outcome.failedIndices;
    // Slot every result the pool produced (success). Skips/failures stay null.
    for (const result of outcome.results) {
      if (result !== null) slots[result.index] = resultToSlot(result);
    }
  } finally {
    await pool.destroy();
  }

  // Breaker fallback: any file the pool did not produce a result for is parsed
  // in-process now (NOT just on a tripped breaker — a respawn-exhausted file also
  // lands in failedIndices, and finishing it in-process is strictly safer than
  // dropping it). Progress was already reported for these indices by the pool, so
  // we must NOT call reportSettled again here.
  const unfinished = failedIndices.filter((i) => slots[i] === null);
  if (unfinished.length > 0) {
    // Reuse the in-process per-file logic with a fresh parser cache. A handful of
    // files; sequential is fine and keeps determinism trivial.
    const parsers = new Map<string, Parser>();
    for (const i of unfinished) {
      slots[i] = await processFile(fileNodes[i], i, relativeBase, parsers);
    }
  }
  void breakerTripped; // surfaced via metrics later; behaviour is identical either way
}

/**
 * Phase 2 pipeline entry point.
 * Returns symbols and raw relationship hints extracted from all files.
 *
 * Files are processed with a bounded-concurrency worker pool (B5). Each worker
 * owns its OWN `Map<variant, Parser>` so a tree-sitter `Parser` is never shared
 * across concurrent parses, while parsers are still reused within a worker.
 *
 * DETERMINISM: each file's output is collected into a slot indexed by its
 * ORIGINAL position in `fileNodes`, then flattened in original order before
 * deduplication. Completion order never leaks into the returned arrays, so the
 * output is byte-for-byte identical to the serial version.
 *
 * @param fileNodes - Files to process (paths relative to rootPath)
 * @param rootPath  - Root used to resolve paths for I/O (defaults to CWD)
 * @param options   - Optional concurrency knob and per-file completion hook (B6)
 *
 * Requirements: 3.2, 4.1, 4.2
 */
export async function extractAllSymbols(
  fileNodes: FileNode[],
  rootPath: string = process.cwd(),
  options: ExtractAllSymbolsOptions = {},
): Promise<ParsingResult> {
  const { symbols, hints, skippedFiles } = await extractAllSymbolsWithPerFile(
    fileNodes,
    rootPath,
    options,
  );
  return { symbols, hints, skippedFiles };
}

/**
 * Phase 2 entry point that ALSO returns a per-file map keyed by relPath (A2).
 *
 * Identical parsing/slot/flatten/dedup behaviour to {@link extractAllSymbols} —
 * the flattened `{symbols, hints, skippedFiles}` are byte-for-byte the same, so
 * `extractAllSymbols` simply drops the extra `perFile` field. The map lets the
 * parse cache store `relPath → { contentHash, symbols, hints }` without a second
 * file read (the hash is computed from the content the parser already read).
 */
export async function extractAllSymbolsWithPerFile(
  fileNodes: FileNode[],
  rootPath: string = process.cwd(),
  options: ExtractAllSymbolsOptions = {},
): Promise<ParsingResultWithPerFile> {
  const total = fileNodes.length;
  const concurrency = Math.max(1, options.concurrency ?? PARSE_CONCURRENCY);
  const onProgress = options.onProgress;

  // Compute the same relativeBase as walkFileTree so paths resolve correctly
  const normalizedRoot = path.resolve(rootPath);
  const cwd = process.cwd();
  const relativeBase = normalizedRoot.startsWith(cwd + path.sep) || normalizedRoot === cwd
    ? cwd
    : normalizedRoot;

  // One slot per original position preserves deterministic ordering regardless
  // of which worker finishes first. This slot array is the single source of
  // truth for BOTH the in-process path and the worker-pool path, so their
  // flattened output is byte-identical.
  const slots: (FileSlot | null)[] = new Array(total).fill(null);
  // Shared, order-independent completion counter (B6). Bumped as each task
  // settles; `done` ends exactly at `total`.
  let done = 0;
  const reportSettled = (index: number): void => {
    done++;
    onProgress?.(done, total, fileNodes[index]?.path);
  };

  // ── Path selection (B1/B2) ──────────────────────────────────────────────────
  // The worker-thread pool is OPT-IN (default OFF): it can hard-abort the process
  // on a native tree-sitter error in some environments, so the proven in-process
  // async path is the default. It engages only above the threshold AND when
  // explicitly enabled — via `TYPOCOP_PARSE_WORKERS` in production, or an injected
  // `poolFactory` (test seam). `useWorkerThreads` overrides both when set.
  const threshold = options.workerThreshold ?? getConfiguredParseWorkerThreshold();
  const workersDefault = options.poolFactory !== undefined || isParseWorkersEnabled();
  const useWorkers = (options.useWorkerThreads ?? workersDefault) && total >= threshold;

  if (useWorkers) {
    await runViaWorkerPool(fileNodes, relativeBase, slots, reportSettled, options);
  } else {
    await runInProcess(fileNodes, relativeBase, slots, concurrency, reportSettled);
  }

  // Skipped files are exactly the settled slots that produced no symbols/hints
  // (null). Derive the count from the slots so both paths agree.
  let skippedFiles = 0;
  for (let i = 0; i < slots.length; i++) {
    if (slots[i] === null) skippedFiles++;
  }

  // Flatten in ORIGINAL order — completion order never affects output. Build the
  // per-file map in the same pass, keyed by relPath, skipping files that had no
  // hash (size-skipped inside parseSourceFile) so the cache only stores real reads.
  const allSymbols: Symbol[] = [];
  const allHints: RawRelationshipHint[] = [];
  const perFile = new Map<string, PerFileParseResult>();
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (slot === null) continue;
    allSymbols.push(...slot.symbols);
    allHints.push(...slot.hints);
    if (slot.contentHash !== undefined) {
      perFile.set(fileNodes[i].path, {
        symbols: slot.symbols,
        hints: slot.hints,
        contentHash: slot.contentHash,
      });
    }
  }

  return {
    symbols: deduplicateById(allSymbols),
    hints: allHints,
    skippedFiles,
    perFile,
  };
}
