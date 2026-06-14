/**
 * Process-level safety net for the connection server (resilience Phase A).
 *
 * In addition to the graceful SIGTERM/SIGINT path, an unexpected stop —
 * uncaughtException, unhandledRejection, or any `process.exit()` elsewhere —
 * must still drop the discovery advertisement and the DB lock so the *next*
 * startup is not blocked by orphaned state.
 *
 * Design for testability: this is a pure function that takes an injectable
 * `proc` (an EventEmitter-shaped object) and `exit` (a `(code) => void`). Tests
 * pass a fake EventEmitter + a spy exit so they can emit the lifecycle events
 * and assert cleanup + exit code WITHOUT killing the test runner. It returns a
 * disposer that removes exactly the listeners it added, so handlers never leak
 * across server instances/tests.
 */

import { logServerEvent } from "../../platform/logging/logger.js";

/** Minimal process surface the safety net relies on (real `process` satisfies it). */
export interface SafetyNetProcess {
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * Snapshot of server liveness captured at the moment of a fatal exit
 * (resilience Phase F). `uptimeMs` comes from a `startedAt` captured at server
 * start; `inFlight`/`queued` from `scheduler.stats()`.
 */
export interface FatalDiagnostics {
  readonly uptimeMs: number;
  readonly inFlight: number;
  readonly queued: number;
}

export interface ProcessSafetyNetOptions {
  /** Synchronous, last-ditch cleanup safe to run inside `process.on("exit")`. */
  readonly cleanupSync: () => void;
  /**
   * Best-effort async cleanup (graceful shutdown) run on a fatal exception
   * before exiting non-zero. Optional; if omitted, only `cleanupSync` runs.
   */
  readonly cleanupAsync?: () => Promise<void>;
  /**
   * Resilience Phase F: liveness snapshot accessor folded into the single
   * `fatal_exit` record. Optional; pure/synchronous and must never throw.
   */
  readonly getDiagnostics?: () => FatalDiagnostics;
  /**
   * Resilience Phase F: best-effort SYNC append of a one-line crash record
   * (next to the discovery file) from inside the `exit` handler. Must never
   * throw — failures are swallowed so they cannot delay or block the exit.
   */
  readonly writeCrashRecordSync?: (record: CrashRecord) => void;
  /** Injected for tests; defaults to the real process. */
  readonly proc?: SafetyNetProcess;
  /** Injected for tests; defaults to `process.exit`. */
  readonly exit?: (code: number) => void;
}

/** One-line post-mortem record appended on an abnormal exit (Phase F). */
export interface CrashRecord {
  readonly reason: string;
  readonly at: string;
  readonly uptimeMs?: number;
  readonly inFlight?: number;
  readonly queued?: number;
}

/**
 * Install the safety net. Returns a disposer that removes every listener it
 * added (call it at the end of graceful shutdown so handlers don't leak).
 *
 * The `cleanupSync`/`cleanupAsync` callbacks are expected to be idempotent
 * (the caller guards them with a single `cleanedUp` flag) so the fatal path and
 * the `exit` path never double-run cleanup.
 */
export function installProcessSafetyNet(options: ProcessSafetyNetOptions): () => void {
  const proc: SafetyNetProcess = options.proc ?? (process as unknown as SafetyNetProcess);
  const exit: (code: number) => void =
    options.exit ?? ((code: number) => process.exit(code));

  // Phase F: emit EXACTLY ONE structured fatal record across every abnormal
  // path (uncaughtException / unhandledRejection / exit). Re-entry no-ops so a
  // crash mid-handler cannot double-log.
  let firedFatal = false;
  const recordFatal = (reason: string, error?: unknown): void => {
    if (firedFatal) {
      return;
    }
    firedFatal = true;
    let diagnostics: FatalDiagnostics | undefined;
    try {
      diagnostics = options.getDiagnostics?.();
    } catch {
      // Diagnostics must never block the fatal record.
    }
    logServerEvent("error", "fatal_exit", {
      reason,
      uptimeMs: diagnostics?.uptimeMs,
      inFlight: diagnostics?.inFlight,
      queued: diagnostics?.queued,
      error,
    });
    // Best-effort SYNC crash record next to the discovery file. Swallow any
    // failure — diagnostics must never delay or block the exit.
    try {
      options.writeCrashRecordSync?.({
        reason,
        at: new Date().toISOString(),
        uptimeMs: diagnostics?.uptimeMs,
        inFlight: diagnostics?.inFlight,
        queued: diagnostics?.queued,
      });
    } catch {
      // best-effort
    }
  };

  const onFatal = (reason: string) => (error: unknown): void => {
    recordFatal(reason, error);
    // Best-effort async cleanup, then exit non-zero. If it hangs, the server's
    // hard-exit backstop timer (Phase B) still terminates the process.
    const finish = (): void => {
      exit(1);
    };
    if (options.cleanupAsync) {
      void Promise.resolve()
        .then(() => options.cleanupAsync!())
        .catch((cleanupError: unknown) => {
          logServerEvent("error", "fatal_cleanup_failed", { reason, error: cleanupError });
        })
        .finally(finish);
    } else {
      try {
        options.cleanupSync();
      } catch {
        // best-effort
      }
      finish();
    }
  };

  const onUncaughtException = onFatal("uncaughtException");
  const onUnhandledRejection = onFatal("unhandledRejection");
  const onExit = (code?: number): void => {
    // `process.on("exit")` may ONLY do synchronous work — async is a silent
    // no-op. The cleanupSync callback is guarded by the shared cleanedUp flag,
    // so this never double-removes after a graceful async cleanup already ran.
    //
    // Phase F: if no fatal record was emitted yet AND the exit is abnormal
    // (non-zero), append one synchronously here. Guarded by `firedFatal` so it
    // never double-emits after an uncaught/unhandled handler already recorded.
    if (typeof code === "number" && code !== 0) {
      recordFatal("exit");
    }
    options.cleanupSync();
  };

  proc.on("uncaughtException", onUncaughtException);
  proc.on("unhandledRejection", onUnhandledRejection);
  proc.on("exit", onExit);

  return () => {
    proc.removeListener("uncaughtException", onUncaughtException);
    proc.removeListener("unhandledRejection", onUnhandledRejection);
    proc.removeListener("exit", onExit);
  };
}
