/**
 * C3 file-watcher tests — debounce coalescing, ignore-filter, and a fake
 * backend so the debounce/Set-coalesce/normalise logic is exercised with fake
 * timers and no real filesystem events.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFileWatcher, type WatchBackend } from "./file-watcher.js";

/** A controllable in-memory backend: tests push raw paths via `emit`. */
function makeFakeBackend(): WatchBackend & {
  emit: (rawPath: string) => void;
  closed: boolean;
} {
  const handlers: Array<(p: string) => void> = [];
  let closed = false;
  return {
    onRaw(cb) {
      handlers.push(cb);
    },
    async close() {
      closed = true;
    },
    emit(rawPath: string) {
      for (const h of handlers) h(rawPath);
    },
    get closed() {
      return closed;
    },
  };
}

describe("createFileWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces N events in the window into a single deduped batch", () => {
    const backend = makeFakeBackend();
    const watcher = createFileWatcher(process.cwd(), { debounceMs: 300, backend });
    const batches: string[][] = [];
    watcher.onBatch((paths) => {
      batches.push(paths);
    });

    // 5 events, only 2 distinct paths, all inside the 300ms window.
    backend.emit("src/a.ts");
    backend.emit("src/b.ts");
    backend.emit("src/a.ts");
    vi.advanceTimersByTime(100);
    backend.emit("src/b.ts");
    backend.emit("src/a.ts");

    // Nothing has fired yet (trailing debounce keeps resetting).
    expect(batches).toHaveLength(0);

    vi.advanceTimersByTime(300);

    expect(batches).toHaveLength(1);
    expect([...batches[0]].sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("emits separate batches for events in separate windows", () => {
    const backend = makeFakeBackend();
    const watcher = createFileWatcher(process.cwd(), { debounceMs: 300, backend });
    const batches: string[][] = [];
    watcher.onBatch((paths) => { batches.push(paths); });

    backend.emit("src/a.ts");
    vi.advanceTimersByTime(300);
    backend.emit("src/b.ts");
    vi.advanceTimersByTime(300);

    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual(["src/a.ts"]);
    expect(batches[1]).toEqual(["src/b.ts"]);
  });

  it("filters out ignored paths (node_modules, dist) and binaries", () => {
    const backend = makeFakeBackend();
    const watcher = createFileWatcher(process.cwd(), { debounceMs: 300, backend });
    const batches: string[][] = [];
    watcher.onBatch((paths) => { batches.push(paths); });

    backend.emit("node_modules/foo/index.js");
    backend.emit("dist/bundle.js");
    backend.emit("src/keep.ts");
    backend.emit("assets/logo.png");
    vi.advanceTimersByTime(300);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(["src/keep.ts"]);
  });

  it("emits no batch when every event in the window is ignored", () => {
    const backend = makeFakeBackend();
    const watcher = createFileWatcher(process.cwd(), { debounceMs: 300, backend });
    const batches: string[][] = [];
    watcher.onBatch((paths) => { batches.push(paths); });

    backend.emit("node_modules/a/index.js");
    backend.emit("dist/x.js");
    vi.advanceTimersByTime(300);

    expect(batches).toHaveLength(0);
  });

  it("normalises absolute paths to cwd-relative POSIX form", () => {
    const backend = makeFakeBackend();
    const watcher = createFileWatcher(process.cwd(), { debounceMs: 300, backend });
    const batches: string[][] = [];
    watcher.onBatch((paths) => { batches.push(paths); });

    backend.emit(`${process.cwd()}/src/nested/file.ts`);
    vi.advanceTimersByTime(300);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(["src/nested/file.ts"]);
  });

  it("close() tears down the backend and stops emitting pending batches", async () => {
    const backend = makeFakeBackend();
    const watcher = createFileWatcher(process.cwd(), { debounceMs: 300, backend });
    const batches: string[][] = [];
    watcher.onBatch((paths) => { batches.push(paths); });

    backend.emit("src/a.ts");
    await watcher.close();
    expect(backend.closed).toBe(true);

    // A timer that would have fired is cleared; advancing does nothing.
    vi.advanceTimersByTime(1000);
    expect(batches).toHaveLength(0);
  });

  it("ignores events received after close()", async () => {
    const backend = makeFakeBackend();
    const watcher = createFileWatcher(process.cwd(), { debounceMs: 300, backend });
    const batches: string[][] = [];
    watcher.onBatch((paths) => { batches.push(paths); });

    await watcher.close();
    backend.emit("src/a.ts");
    vi.advanceTimersByTime(300);

    expect(batches).toHaveLength(0);
  });
});
