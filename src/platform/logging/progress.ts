/**
 * Tiny, dependency-free progress renderer for long CPU-bound phases (B6).
 *
 * The indexing PIPELINE owns rendering — it constructs a renderer and passes its
 * {@link ProgressRenderer.onProgress} as the `onProgress` hook to
 * `extractAllSymbols`. The parser never renders. All output goes to the injected
 * stream (stderr in production); nothing is ever written to stdout, so MCP/server
 * protocol output on stdout is unaffected.
 *
 * Two modes, selected by `stream.isTTY`:
 *
 * - TTY: a single carriage-return-rewound line with a unicode bar, throttled to
 *   at most one redraw per {@link TTY_THROTTLE_MS} (tree-sitter parsing is
 *   synchronous and starves the event loop, so redrawing once per file would be
 *   pure overhead). The final 100% frame is always drawn, then the line is
 *   cleared with `\x1b[2K\r`.
 * - Non-TTY: NO ANSI/escape codes. Quiet by default; only when `verbose` is true
 *   does it emit occasional plain-text lines (every ~10% / every K files), so CI
 *   logs and redirected output stay readable.
 *
 * Throttling uses `performance.now()` (monotonic) rather than `Date.now()`.
 */

/** Minimal stream surface this renderer needs — satisfied by `process.stderr`. */
export interface ProgressStream {
  write(chunk: string): unknown;
  readonly isTTY?: boolean;
}

export interface ProgressRendererOptions {
  /** Output sink. Defaults to `process.stderr`. */
  readonly stream?: ProgressStream;
  /** Gates non-TTY plain-text chatter. Defaults to false (quiet). */
  readonly verbose?: boolean;
  /** Short phase label, e.g. "Phase 2: parsing". */
  readonly label?: string;
}

/** Minimum wall-time between TTY redraws (ms). One frame at ~30 fps. */
export const TTY_THROTTLE_MS = 33;

/** Non-TTY verbose: emit a plain line at most this often (fraction of total). */
const PLAIN_STEP_FRACTION = 0.1;

/** Non-TTY verbose: also emit at least this often by file count. */
const PLAIN_STEP_FILES = 200;

const BAR_WIDTH = 24;
const FILLED = "█"; // █
const EMPTY = "░"; // ░
const LEFT_EDGE = "▕"; // ▕
const RIGHT_EDGE = "▏"; // ▏

function renderBar(done: number, total: number): string {
  const ratio = total > 0 ? done / total : 1;
  const filled = Math.round(ratio * BAR_WIDTH);
  const bar = FILLED.repeat(filled) + EMPTY.repeat(Math.max(0, BAR_WIDTH - filled));
  const pct = Math.round(ratio * 100);
  return `${LEFT_EDGE}${bar}${RIGHT_EDGE} ${done}/${total} (${pct}%)`;
}

/**
 * A stateful renderer. Call {@link ProgressRenderer.onProgress} once per settled
 * file (this is the same per-file completion hook `extractAllSymbols` invokes).
 * Call {@link ProgressRenderer.done} once when the phase finishes to draw the
 * final frame and clear the line.
 */
export class ProgressRenderer {
  private readonly stream: ProgressStream;
  private readonly isTTY: boolean;
  private readonly verbose: boolean;
  private readonly label: string;
  private lastDrawMs = -Infinity;
  private lastPlainDone = 0;
  private started = false;
  private finished = false;

  constructor(options: ProgressRendererOptions = {}) {
    this.stream = options.stream ?? process.stderr;
    this.isTTY = this.stream.isTTY === true;
    this.verbose = options.verbose ?? false;
    this.label = options.label ?? "Phase 2: parsing";
  }

  /** Per-file completion hook. Matches the `onProgress` signature exactly. */
  onProgress = (done: number, total: number, _currentPath?: string): void => {
    if (this.finished) return;

    if (this.isTTY) {
      const now = performance.now();
      const isLast = done >= total;
      // Throttle: skip unless enough time passed — but ALWAYS draw the final
      // frame so the bar visibly reaches 100% before being cleared.
      if (!isLast && this.started && now - this.lastDrawMs < TTY_THROTTLE_MS) return;
      this.lastDrawMs = now;
      this.started = true;
      this.stream.write(`\r[pipeline] ${this.label} ${renderBar(done, total)}`);
      return;
    }

    // Non-TTY: nothing unless verbose.
    if (!this.verbose) return;
    const isLast = done >= total;
    const step = Math.max(1, Math.min(PLAIN_STEP_FILES, Math.ceil(total * PLAIN_STEP_FRACTION)));
    if (!isLast && done - this.lastPlainDone < step) return;
    this.lastPlainDone = done;
    const pct = total > 0 ? Math.round((done / total) * 100) : 100;
    this.stream.write(`[pipeline] ${this.label}: ${done}/${total} (${pct}%)\n`);
  };

  /**
   * Finish the phase. On a TTY this clears the rewound progress line. Idempotent.
   * The final 100% frame is normally drawn by the last {@link onProgress} call;
   * `done()` only clears.
   */
  done(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.isTTY && this.started) {
      // Clear the current line and return the cursor to column 0.
      this.stream.write("\x1b[2K\r");
    }
  }
}

/**
 * Convenience factory mirroring the surrounding functional style. Returns the
 * renderer so callers can both pass `onProgress` and call `done()` on completion.
 */
export function createProgressRenderer(options: ProgressRendererOptions = {}): ProgressRenderer {
  return new ProgressRenderer(options);
}
