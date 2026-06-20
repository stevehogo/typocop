/**
 * Generic, domain-agnostic resilient worker pool over `node:worker_threads` (B1).
 *
 * Knows NOTHING about tree-sitter or parsing — it dispatches opaque indexed tasks
 * to N persistent workers and collects results into slots keyed by each task's
 * ORIGINAL index, so the caller can flatten in deterministic order regardless of
 * which worker finished first.
 *
 * Resilience (Risk R4):
 *  - **per-task timeout** — a task whose worker goes silent past `taskTimeoutMs`
 *    is failed and its worker recycled.
 *  - **cumulative-timeout budget** — once `maxCumulativeTimeoutMs` of wall time is
 *    spent in timed-out tasks, the breaker trips (a pathological repo never hangs
 *    the whole index).
 *  - **respawn budget** — a worker that crashes/exits is respawned, counted
 *    against `maxRespawns`; exhausting it trips the breaker.
 *  - **circuit breaker** — once tripped, no further tasks are dispatched; the
 *    remaining tasks are returned as `failedIndices` so the caller can finish them
 *    on its own (the in-process fallback). Indexing never aborts.
 *
 * `onSettled` fires EXACTLY ONCE per task — on success, on skip-style failure, or
 * on a breaker-forced give-up — so a progress/metrics counter always reaches
 * `total`.
 *
 * The pool is transport-only: it serialises a `{ kind: "task", task }` frame and
 * expects a `{ kind: "result", result }` frame back. The result is opaque `R`.
 */
import { Worker } from "node:worker_threads";

/** A task the pool can dispatch — only constraint is a stable original `index`. */
export interface IndexedTask {
  readonly index: number;
}

/** A result the pool collects — must echo back the task `index` for slotting. */
export interface IndexedResult {
  readonly index: number;
}

export interface WorkerPoolOptions {
  /** Number of persistent workers. Clamped to `>= 1` and to the task count. */
  readonly size: number;
  /**
   * Absolute path (or `file://` URL string) to the worker entry module. Resolved
   * by the caller so this generic pool stays free of any module layout knowledge.
   */
  readonly workerEntry: string;
  /**
   * Arbitrary JSON-serialisable data passed to each worker as `workerData`. The
   * parse worker uses this for nothing today but it keeps the pool reusable.
   */
  readonly workerData?: unknown;
  /** `execArgv` forwarded to each `Worker` (e.g. to inherit a loader). */
  readonly execArgv?: string[];
  /** Per-task silence timeout (ms) before the task is failed + worker recycled. */
  readonly taskTimeoutMs?: number;
  /** Cumulative timed-out wall time (ms) that trips the breaker. */
  readonly maxCumulativeTimeoutMs?: number;
  /** Total worker respawns allowed across the run before the breaker trips. */
  readonly maxRespawns?: number;
}

export interface WorkerPoolRunResult<R> {
  /** One slot per original index; `null` for tasks that failed or were skipped. */
  readonly results: (R | null)[];
  /** True once the circuit breaker tripped (caller should run its fallback). */
  readonly breakerTripped: boolean;
  /** Original indices that did NOT produce a result (failed / timed-out / abandoned). */
  readonly failedIndices: number[];
}

const DEFAULT_TASK_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CUMULATIVE_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPAWNS = 8;

/** A worker plus the single in-flight task it currently owns (if any). */
interface Slot {
  worker: Worker;
  /** Index of the task this worker is processing, or `null` when idle. */
  current: number | null;
  /** Per-task watchdog timer. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Set when we are intentionally terminating this worker (ignore its exit). */
  retiring: boolean;
}

/**
 * Resilient pool. One instance ↔ one `worker_threads` fleet; call {@link run}
 * once (it drains all tasks) then {@link destroy} in a `finally`.
 */
export class WorkerPool<T extends IndexedTask, R extends IndexedResult> {
  private readonly opts: Required<
    Pick<WorkerPoolOptions, "taskTimeoutMs" | "maxCumulativeTimeoutMs" | "maxRespawns">
  > &
    WorkerPoolOptions;
  private slots: Slot[] = [];
  private destroyed = false;

  constructor(options: WorkerPoolOptions) {
    this.opts = {
      ...options,
      taskTimeoutMs: options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
      maxCumulativeTimeoutMs:
        options.maxCumulativeTimeoutMs ?? DEFAULT_MAX_CUMULATIVE_TIMEOUT_MS,
      maxRespawns: options.maxRespawns ?? DEFAULT_MAX_RESPAWNS,
    };
  }

  /**
   * Dispatch every task, collecting results into original-index slots.
   *
   * `onSettled(index)` fires exactly once per task — including failures and
   * breaker-abandoned tasks — so a shared progress counter ends at `tasks.length`.
   */
  run(tasks: readonly T[], onSettled?: (index: number) => void): Promise<WorkerPoolRunResult<R>> {
    const total = tasks.length;
    const results: (R | null)[] = new Array(total).fill(null);
    const failedIndices: number[] = [];
    // Each index is settled at most once; this guards the breaker drain path.
    const settled = new Set<number>();

    return new Promise<WorkerPoolRunResult<R>>((resolve) => {
      if (total === 0) {
        resolve({ results, breakerTripped: false, failedIndices });
        return;
      }

      const size = Math.max(1, Math.min(this.opts.size, total));
      let nextTask = 0;
      let outstanding = 0;
      let respawns = 0;
      let cumulativeTimeoutMs = 0;
      let breakerTripped = false;
      let finished = false;

      const settle = (index: number, ok: R | null): void => {
        if (settled.has(index)) return;
        settled.add(index);
        if (ok !== null) {
          results[index] = ok;
        } else {
          failedIndices.push(index);
        }
        outstanding--;
        onSettled?.(index);
      };

      const maybeFinish = (): void => {
        if (finished) return;
        // Done when every task has settled (success or failure). Once the breaker
        // is tripped we abandon all not-yet-settled tasks below, so this still
        // reaches `total`.
        if (settled.size >= total) {
          finished = true;
          this.clearAllTimers();
          resolve({
            results,
            breakerTripped,
            failedIndices: failedIndices.sort((a, b) => a - b),
          });
        }
      };

      const tripBreaker = (): void => {
        if (breakerTripped) return;
        breakerTripped = true;
        // Abandon every task not yet settled: pending (never dispatched) AND any
        // in-flight task on a live worker. The caller finishes these in-process.
        for (const slot of this.slots) {
          if (slot.current !== null) {
            this.clearTimer(slot);
            const idx = slot.current;
            slot.current = null;
            settle(idx, null);
          }
        }
        while (nextTask < total) {
          const t = tasks[nextTask++];
          settle(t.index, null);
        }
        maybeFinish();
      };

      const dispatchTo = (slot: Slot): void => {
        if (breakerTripped) return;
        if (nextTask >= total) return;
        const task = tasks[nextTask++];
        slot.current = task.index;
        outstanding++;
        this.armTimer(slot, () => onTaskTimeout(slot));
        slot.worker.postMessage({ kind: "task", task });
      };

      const onTaskTimeout = (slot: Slot): void => {
        if (finished || slot.current === null) return;
        cumulativeTimeoutMs += this.opts.taskTimeoutMs;
        const idx = slot.current;
        slot.current = null;
        this.clearTimer(slot);
        // A silent worker is presumed wedged: recycle it (counts against respawns).
        settle(idx, null);
        if (cumulativeTimeoutMs >= this.opts.maxCumulativeTimeoutMs) {
          tripBreaker();
          return;
        }
        recycle(slot);
        maybeFinish();
      };

      const onMessage = (slot: Slot, msg: unknown): void => {
        if (finished) return;
        const result = (msg as { kind?: string; result?: R })?.result;
        if (
          (msg as { kind?: string })?.kind !== "result" ||
          result === undefined ||
          slot.current === null ||
          result.index !== slot.current
        ) {
          // Out-of-band / mismatched frame — ignore; the watchdog covers a stall.
          return;
        }
        this.clearTimer(slot);
        slot.current = null;
        settle(result.index, result);
        if (!breakerTripped) dispatchTo(slot);
        maybeFinish();
      };

      const onExit = (slot: Slot): void => {
        if (finished || slot.retiring) return;
        // A worker crashed/segfaulted mid-task. Fail its in-flight task (the file
        // is effectively skipped) and respawn into the same slot.
        this.clearTimer(slot);
        if (slot.current !== null) {
          const idx = slot.current;
          slot.current = null;
          settle(idx, null);
        }
        recycle(slot);
        maybeFinish();
      };

      const recycle = (slot: Slot): void => {
        if (finished || breakerTripped) return;
        if (respawns >= this.opts.maxRespawns) {
          tripBreaker();
          return;
        }
        respawns++;
        this.retireWorker(slot);
        this.spawnInto(slot, onMessage, onExit);
        // Keep the recycled worker busy if tasks remain.
        dispatchTo(slot);
      };

      // Spawn the fleet and prime each worker with one task.
      for (let i = 0; i < size; i++) {
        const slot: Slot = { worker: undefined as unknown as Worker, current: null, timer: null, retiring: false };
        this.slots.push(slot);
        this.spawnInto(slot, onMessage, onExit);
        dispatchTo(slot);
      }
    });
  }

  /** Terminate the whole fleet. Idempotent; safe to call from a `finally`. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearAllTimers();
    await Promise.all(
      this.slots.map((slot) => {
        slot.retiring = true;
        return slot.worker.terminate().catch(() => undefined);
      }),
    );
    this.slots = [];
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  private spawnInto(
    slot: Slot,
    onMessage: (slot: Slot, msg: unknown) => void,
    onExit: (slot: Slot) => void,
  ): void {
    slot.retiring = false;
    const worker = new Worker(this.opts.workerEntry, {
      workerData: this.opts.workerData,
      execArgv: this.opts.execArgv,
    });
    worker.on("message", (msg) => onMessage(slot, msg));
    worker.on("error", () => onExit(slot)); // an uncaught worker throw → treat as exit
    worker.on("exit", () => onExit(slot));
    worker.unref(); // never keep the process alive on the pool's account
    slot.worker = worker;
  }

  private retireWorker(slot: Slot): void {
    slot.retiring = true;
    void slot.worker.terminate().catch(() => undefined);
  }

  private armTimer(slot: Slot, onFire: () => void): void {
    this.clearTimer(slot);
    slot.timer = setTimeout(onFire, this.opts.taskTimeoutMs);
    // Don't let the watchdog hold the loop open.
    if (typeof slot.timer.unref === "function") slot.timer.unref();
  }

  private clearTimer(slot: Slot): void {
    if (slot.timer !== null) {
      clearTimeout(slot.timer);
      slot.timer = null;
    }
  }

  private clearAllTimers(): void {
    for (const slot of this.slots) this.clearTimer(slot);
  }
}
