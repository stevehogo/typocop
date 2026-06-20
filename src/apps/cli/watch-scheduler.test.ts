/**
 * C3 single-flight scheduler tests — verify reindex runs never interleave, that
 * batches arriving mid-flight are coalesced into one follow-up run, and that the
 * follow-up dedupes paths. Uses a fake `run` (manual promise control) + fake
 * timers, no real adapter/filesystem.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSingleFlightScheduler } from "./executor.js";

describe("createSingleFlightScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not interleave reindex calls (single-flight)", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const calls: string[][] = [];
    // Each run takes 100ms (fake-timer) so overlap would be observable.
    const run = vi.fn(async (paths: string[]) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      calls.push(paths);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      concurrent--;
    });

    const scheduler = createSingleFlightScheduler(run);

    // Three batches fired back-to-back while the first run is still in flight.
    scheduler.schedule(["a.ts"]);
    scheduler.schedule(["b.ts"]);
    scheduler.schedule(["c.ts"]);

    // First run started immediately; the other two are queued, not started.
    expect(run).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual(["a.ts"]);

    await vi.advanceTimersByTimeAsync(100); // first run completes → drain queue
    await vi.advanceTimersByTimeAsync(100); // second (drained) run completes

    await scheduler.whenIdle();

    expect(maxConcurrent).toBe(1); // never overlapped
    expect(run).toHaveBeenCalledTimes(2); // one initial + one coalesced follow-up
    // Follow-up carries the union of paths queued during the first run.
    expect([...calls[1]].sort()).toEqual(["b.ts", "c.ts"]);
  });

  it("dedupes paths queued during an in-flight run", async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (paths: string[]) => {
      calls.push(paths);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    });
    const scheduler = createSingleFlightScheduler(run);

    scheduler.schedule(["x.ts"]);
    scheduler.schedule(["y.ts"]);
    scheduler.schedule(["y.ts"]); // duplicate
    scheduler.schedule(["x.ts"]); // already running, queued again

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await scheduler.whenIdle();

    expect(calls[0]).toEqual(["x.ts"]);
    expect([...calls[1]].sort()).toEqual(["x.ts", "y.ts"]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("runs sequentially for spaced-out batches (no queueing)", async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (paths: string[]) => {
      calls.push(paths);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    const scheduler = createSingleFlightScheduler(run);

    scheduler.schedule(["a.ts"]);
    await vi.advanceTimersByTimeAsync(10);
    await scheduler.whenIdle();

    scheduler.schedule(["b.ts"]);
    await vi.advanceTimersByTimeAsync(10);
    await scheduler.whenIdle();

    expect(calls).toEqual([["a.ts"], ["b.ts"]]);
  });

  it("ignores an empty initial batch", () => {
    const run = vi.fn(async () => {});
    const scheduler = createSingleFlightScheduler(run);
    scheduler.schedule([]);
    expect(run).not.toHaveBeenCalled();
  });
});
