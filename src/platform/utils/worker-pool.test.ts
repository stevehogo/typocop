/**
 * Tests for the generic resilient {@link WorkerPool} (B1).
 *
 * Exercises the pool against a real `worker_threads` fleet driven by a synthetic
 * ESM worker fixture (`worker-pool.test-worker.mjs`) — so the transport,
 * slot-by-original-index collection, per-task timeout, respawn budget, circuit
 * breaker, and once-per-task `onSettled` are all covered without any tree-sitter
 * dependency. The pool is domain-agnostic; the parsing integration is tested
 * separately in the parsing index suite.
 */
import { afterEach, describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { WorkerPool } from "./worker-pool.js";

const WORKER = fileURLToPath(new URL("./worker-pool.test-worker.mjs", import.meta.url));

interface Task {
  index: number;
  value?: number;
  delayMs?: number;
  crash?: boolean;
  hang?: boolean;
}
interface Result {
  index: number;
  value: number;
}

const pools: WorkerPool<Task, Result>[] = [];
function makePool(opts: Partial<ConstructorParameters<typeof WorkerPool>[0]> = {}) {
  const pool = new WorkerPool<Task, Result>({
    size: 4,
    workerEntry: WORKER,
    ...opts,
  });
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.destroy()));
});

describe("WorkerPool", () => {
  it("returns an empty result set for zero tasks", async () => {
    const pool = makePool();
    const out = await pool.run([]);
    expect(out.results).toEqual([]);
    expect(out.failedIndices).toEqual([]);
    expect(out.breakerTripped).toBe(false);
  });

  it("collects results into ORIGINAL-INDEX slots regardless of completion order", async () => {
    const pool = makePool({ size: 4 });
    // Reverse the per-task delays so later tasks finish FIRST — if slotting
    // leaked completion order the values would be permuted.
    const tasks: Task[] = Array.from({ length: 20 }, (_, i) => ({
      index: i,
      value: i * 10,
      delayMs: (20 - i) * 2,
    }));
    const out = await pool.run(tasks);
    expect(out.breakerTripped).toBe(false);
    expect(out.failedIndices).toEqual([]);
    expect(out.results.map((r) => r?.value)).toEqual(tasks.map((t) => t.value));
  });

  it("fires onSettled exactly once per task (incl. all indices)", async () => {
    const pool = makePool();
    const tasks: Task[] = Array.from({ length: 30 }, (_, i) => ({ index: i, value: i }));
    const counts = new Map<number, number>();
    let total = 0;
    await pool.run(tasks, (index) => {
      counts.set(index, (counts.get(index) ?? 0) + 1);
      total++;
    });
    expect(total).toBe(tasks.length);
    expect([...counts.keys()].sort((a, b) => a - b)).toEqual(tasks.map((t) => t.index));
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
  });

  it("isolates a crashing task: the file fails, the rest succeed (respawn)", async () => {
    const pool = makePool({ size: 3, maxRespawns: 16 });
    const tasks: Task[] = Array.from({ length: 12 }, (_, i) => ({
      index: i,
      value: i,
      crash: i === 5, // one poison file mid-stream
    }));
    let settled = 0;
    const out = await pool.run(tasks, () => settled++);
    expect(settled).toBe(tasks.length); // onSettled still fires for everyone
    expect(out.breakerTripped).toBe(false); // respawn budget absorbed the crash
    expect(out.failedIndices).toEqual([5]);
    expect(out.results[5]).toBeNull();
    // Every non-poison task produced its result in the right slot.
    for (let i = 0; i < tasks.length; i++) {
      if (i === 5) continue;
      expect(out.results[i]?.value).toBe(i);
    }
  });

  it("trips the breaker when the respawn budget is exhausted", async () => {
    // Every task crashes; with a tiny respawn budget the pool gives up and
    // reports the remainder as failed rather than respawning forever.
    const pool = makePool({ size: 2, maxRespawns: 3 });
    const tasks: Task[] = Array.from({ length: 10 }, (_, i) => ({ index: i, crash: true }));
    let settled = 0;
    const out = await pool.run(tasks, () => settled++);
    expect(out.breakerTripped).toBe(true);
    expect(settled).toBe(tasks.length); // breaker abandons remaining → still settled
    expect(out.results.every((r) => r === null)).toBe(true);
    expect(out.failedIndices.length).toBe(tasks.length);
  });

  it("times out a silent (hung) task and recycles its worker", async () => {
    const pool = makePool({ size: 2, taskTimeoutMs: 150, maxRespawns: 16 });
    const tasks: Task[] = [
      { index: 0, value: 0 },
      { index: 1, hang: true }, // never replies → watchdog fires
      { index: 2, value: 2 },
      { index: 3, value: 3 },
    ];
    const out = await pool.run(tasks);
    expect(out.failedIndices).toEqual([1]);
    expect(out.results[0]?.value).toBe(0);
    expect(out.results[2]?.value).toBe(2);
    expect(out.results[3]?.value).toBe(3);
  });

  it("trips the breaker on cumulative timeout budget", async () => {
    const pool = makePool({
      size: 4,
      taskTimeoutMs: 100,
      maxCumulativeTimeoutMs: 250, // ~3 timed-out tasks trips it
      maxRespawns: 64,
    });
    const tasks: Task[] = Array.from({ length: 12 }, (_, i) => ({ index: i, hang: true }));
    let settled = 0;
    const out = await pool.run(tasks, () => settled++);
    expect(out.breakerTripped).toBe(true);
    expect(settled).toBe(tasks.length);
    expect(out.results.every((r) => r === null)).toBe(true);
  });
});
