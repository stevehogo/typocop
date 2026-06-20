/**
 * File watcher (C3) — watches a source tree and emits *coalesced, debounced,
 * ignore-filtered* batches of changed paths. Used by the CLI `watch` command to
 * drive incremental re-indexing.
 *
 * LAYERING: self-contained infrastructure adapter — only `node:` builtins, the
 * `chokidar` watch dependency, and the leaf `platform/utils/ignore` helper. No
 * sibling-infra imports (`infra-no-sibling`).
 *
 * The raw event source is injectable via {@link FileWatcherOptions.backend} so
 * the debounce / Set-coalescing / ignore-filter / cwd-normalisation logic is
 * unit-testable over a fake backend with fake timers — no real filesystem
 * events or chokidar instance required. The default backend wraps chokidar
 * (recommended over `fs.watch` for WSL2 reliability).
 */
import path from "node:path";
import { shouldIgnorePath } from "../../platform/utils/ignore.js";

/** Public watcher handle returned by {@link createFileWatcher}. */
export interface FileWatcher {
  /**
   * Register a callback invoked once per *coalesced* batch. `changedPaths` is a
   * deduped, ignore-filtered, cwd-relative (POSIX) list. The callback may be
   * async; the watcher does NOT await it (single-flight serialisation is the
   * caller's concern — see the CLI executor).
   */
  onBatch(cb: (changedPaths: string[]) => void | Promise<void>): void;
  /** Stop watching and release the underlying backend. Idempotent. */
  close(): Promise<void>;
}

/**
 * Minimal raw-event backend the watcher consumes. A backend emits absolute (or
 * any) file paths as they change; the watcher handles all
 * debounce/coalesce/filter/normalise logic on top.
 */
export interface WatchBackend {
  /** Subscribe to raw change events (add / change / unlink, all flattened). */
  onRaw(cb: (rawPath: string) => void): void;
  /** Tear down the backend. */
  close(): Promise<void>;
}

export interface FileWatcherOptions {
  /** Trailing-debounce window in ms. Defaults to 300. */
  debounceMs?: number;
  /**
   * Injectable raw-event backend. Defaults to a chokidar-backed implementation
   * rooted at `rootPath`. Provided by tests to exercise the coalescing logic
   * without touching the filesystem.
   */
  backend?: WatchBackend;
}

const DEFAULT_DEBOUNCE_MS = 300;

/**
 * Normalise a raw event path to a cwd-relative POSIX path (matching how the
 * indexer/git layers key files). Absolute paths are made relative to
 * `process.cwd()`; already-relative paths are passed through. Backslashes are
 * converted so Windows/WSL paths compare cleanly.
 */
function toCwdRelative(rawPath: string): string {
  const abs = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
  const rel = path.relative(process.cwd(), abs);
  return rel.split(path.sep).join("/");
}

/**
 * Create a {@link FileWatcher} over `rootPath`. Events are accumulated into a
 * Set (coalescing duplicate paths within the window), filtered through
 * {@link shouldIgnorePath} (drops `node_modules`/`dist`/binaries/etc.), and
 * flushed as a single batch after a trailing debounce of `debounceMs`.
 *
 * Each new raw event RESETS the debounce timer (trailing edge): a burst of N
 * events arriving inside the window produces exactly one batch containing the
 * deduped, surviving paths. If every path in a window is ignore-filtered out,
 * no batch is emitted.
 */
export function createFileWatcher(
  rootPath: string,
  opts: FileWatcherOptions = {},
): FileWatcher {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const backend = opts.backend ?? createChokidarBackend(rootPath);

  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let callback: ((changedPaths: string[]) => void | Promise<void>) | null = null;
  let closed = false;

  const flush = (): void => {
    timer = null;
    if (pending.size === 0) return;
    const batch = [...pending];
    pending.clear();
    if (callback) {
      // Fire-and-forget: the watcher does not serialise callbacks. Surface a
      // rejected promise rather than letting it become an unhandled rejection.
      void Promise.resolve(callback(batch)).catch(() => {
        /* caller is responsible for handling its own errors */
      });
    }
  };

  backend.onRaw((rawPath: string) => {
    if (closed) return;
    const rel = toCwdRelative(rawPath);
    // Ignore-filter (node_modules/dist/binaries/etc.). An empty relative path
    // (an event on cwd itself) is also dropped.
    if (rel.length === 0 || shouldIgnorePath(rel)) return;
    pending.add(rel);
    // Trailing debounce: reset the timer on every surviving event.
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  });

  return {
    onBatch(cb) {
      callback = cb;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending.clear();
      await backend.close();
    },
  };
}

/**
 * Default {@link WatchBackend}: a chokidar watcher rooted at `rootPath`. Add /
 * change / unlink events are flattened to a single raw-path stream; chokidar's
 * own `ignoreInitial` suppresses the startup add-storm so we only react to real
 * changes.
 */
function createChokidarBackend(rootPath: string): WatchBackend {
  // Lazily required so importing this module (e.g. in tests that inject their
  // own backend) does not construct a real watcher.
  let watcherPromise: Promise<import("chokidar").FSWatcher> | null = null;
  const handlers: Array<(rawPath: string) => void> = [];

  const ensureWatcher = (): Promise<import("chokidar").FSWatcher> => {
    if (!watcherPromise) {
      watcherPromise = import("chokidar").then(({ watch }) => {
        const w = watch(rootPath, {
          ignoreInitial: true,
          // Cheap path-segment ignore at the chokidar layer; the watcher core
          // re-applies `shouldIgnorePath` authoritatively after normalisation.
          ignored: (p: string) => shouldIgnorePath(p),
          persistent: true,
        });
        const emit = (rawPath: string): void => {
          for (const h of handlers) h(rawPath);
        };
        w.on("add", emit);
        w.on("change", emit);
        w.on("unlink", emit);
        return w;
      });
    }
    return watcherPromise;
  };

  return {
    onRaw(cb) {
      handlers.push(cb);
      // Start the watcher on first subscription.
      void ensureWatcher();
    },
    async close() {
      if (watcherPromise) {
        const w = await watcherPromise;
        await w.close();
      }
    },
  };
}
