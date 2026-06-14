// Tests for mapWithConcurrency — order preservation, concurrency cap, rejection.

import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "./async-pool.js";

/** A deferred promise plus its resolve handle, for controlling completion order. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("mapWithConcurrency", () => {
  it("returns an empty array for empty input", async () => {
    const out = await mapWithConcurrency([], 4, async () => 1);
    expect(out).toEqual([]);
  });

  it("preserves input order (result[i] corresponds to items[i])", async () => {
    const items = [0, 1, 2, 3, 4, 5];
    const out = await mapWithConcurrency(items, 3, async (n) => n * 10);
    expect(out).toEqual([0, 10, 20, 30, 40, 50]);
  });

  it("preserves order even when later items finish first", async () => {
    const items = [0, 1, 2, 3];
    const out = await mapWithConcurrency(items, 4, async (n) => {
      // Earlier indices resolve LATER, so completion order is reversed.
      await new Promise((r) => setTimeout(r, (items.length - n) * 5));
      return `v${n}`;
    });
    expect(out).toEqual(["v0", "v1", "v2", "v3"]);
  });

  it("passes the original index to fn", async () => {
    const items = ["a", "b", "c"];
    const out = await mapWithConcurrency(items, 2, async (item, i) => `${i}:${item}`);
    expect(out).toEqual(["0:a", "1:b", "2:c"]);
  });

  it("never exceeds the concurrency limit (tracks in-flight count)", async () => {
    const limit = 2;
    let inFlight = 0;
    let maxInFlight = 0;
    const gates = Array.from({ length: 6 }, () => deferred<void>());

    const run = mapWithConcurrency(gates, limit, async (gate, i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate.promise;
      inFlight--;
      return i;
    });

    // Let the pool start; only `limit` tasks should be in flight.
    await new Promise((r) => setTimeout(r, 5));
    expect(maxInFlight).toBeLessThanOrEqual(limit);
    expect(inFlight).toBe(limit);

    // Release gates one at a time; cap must hold throughout.
    for (const g of gates) {
      g.resolve();
      await new Promise((r) => setTimeout(r, 1));
      expect(maxInFlight).toBeLessThanOrEqual(limit);
    }

    const out = await run;
    expect(out).toEqual([0, 1, 2, 3, 4, 5]);
    expect(maxInFlight).toBe(limit);
  });

  it("clamps limit to at least 1 (limit <= 0 still runs serially)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const out = await mapWithConcurrency([1, 2, 3], 0, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return n;
    });
    expect(out).toEqual([1, 2, 3]);
    expect(maxInFlight).toBe(1);
  });

  it("never starts more workers than items", async () => {
    let maxInFlight = 0;
    let inFlight = 0;
    await mapWithConcurrency([1, 2], 100, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return n;
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("propagates a rejection from fn", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});
