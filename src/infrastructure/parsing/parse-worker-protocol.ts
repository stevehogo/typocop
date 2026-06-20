/**
 * Shared message/result contracts for the parse worker (B1).
 *
 * These types cross the `worker_threads` boundary via structured clone, so every
 * field must be PLAIN JSON-serialisable: `ParseTask` carries only strings/numbers,
 * and `ParseTaskResult` carries `Symbol`/`RawRelationshipHint` arrays which are
 * themselves plain data (verified: no native tree-sitter handles). A live
 * `Parser`/`Tree`/`Query` must NEVER appear here — those stay inside the worker.
 *
 * The protocol is deliberately tree-sitter-agnostic at the transport level: the
 * generic {@link WorkerPool} in `platform/utils/worker-pool.ts` dispatches an
 * opaque indexed task and collects an opaque indexed result; only this module and
 * the worker entry know the task/result are about parsing.
 */
import type { Symbol, Language } from "../../core/domain.js";
import type { RawRelationshipHint } from "./extract-symbols.js";

/**
 * One unit of parse work, addressed by its ORIGINAL index in the file list so
 * the pool can slot the result back into deterministic position regardless of
 * which worker (or in what order) completes it.
 */
export interface ParseTask {
  /** Original position in the caller's `fileNodes` array — the slot key. */
  readonly index: number;
  /** Absolute path the worker reads from. */
  readonly filePath: string;
  /** Path relative to the index root — stored on emitted symbols/hints. */
  readonly relativePath: string;
  readonly language: Language;
  /** File size already collected in Phase 1 (skips a redundant `fs.stat`). */
  readonly size: number;
}

/**
 * A file the worker successfully parsed: the extracted symbols/hints plus the
 * `sha256` of the exact content it read (A2), so the per-file cache map
 * (`relPath → { symbols, hints, contentHash }`) is preserved across the pool.
 */
export interface ParseTaskSuccess {
  readonly index: number;
  readonly symbols: Symbol[];
  readonly hints: RawRelationshipHint[];
  readonly contentHash: string;
}

/**
 * A file the worker chose to SKIP — a parser-init failure or a `ParseError`
 * (oversized / unreadable / syntax-fatal). The worker never dies on these; it
 * reports the skip and moves on. The caller counts it in `skippedFiles`.
 */
export interface ParseTaskSkipped {
  readonly index: number;
  readonly skipped: true;
  readonly reason: string;
}

/** Plain result posted back per task — a success or a skip, never a throw. */
export type ParseTaskResult = ParseTaskSuccess | ParseTaskSkipped;

/** Narrowing helper: did this task settle as a skip? */
export function isParseSkipped(r: ParseTaskResult): r is ParseTaskSkipped {
  return (r as ParseTaskSkipped).skipped === true;
}

// ─── worker_threads wire frames ───────────────────────────────────────────────
// The generic pool speaks these frames so the worker entry and the pool agree on
// the envelope. `kind` discriminates dispatch vs. the worker's reply.

/** Main → worker: run this task. */
export interface WorkerTaskMessage {
  readonly kind: "task";
  readonly task: ParseTask;
}

/** Worker → main: this task settled (success or skip). */
export interface WorkerResultMessage {
  readonly kind: "result";
  readonly result: ParseTaskResult;
}

export type WorkerInbound = WorkerTaskMessage;
export type WorkerOutbound = WorkerResultMessage;
