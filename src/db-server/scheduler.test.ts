import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@grpc/grpc-js", () => ({
  status: {
    DEADLINE_EXCEEDED: 4,
    RESOURCE_EXHAUSTED: 8,
    UNAVAILABLE: 14,
    INTERNAL: 13,
  },
}));

import { QueueFullError, RequestTimeoutError, ServerDrainingError } from "./errors.js";
import { PriorityRequestScheduler } from "./scheduler.js";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolveFn!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("PriorityRequestScheduler", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("executes higher-priority queued requests before lower-priority ones", async () => {
    const scheduler = new PriorityRequestScheduler(1, 4);
    const gate = deferred<void>();
    const executed: string[] = [];

    const first = scheduler.enqueue({
      id: "first",
      priority: "background_write",
      timeoutMs: 2_000,
      execute: async () => {
        executed.push("first");
        await gate.promise;
        return "first";
      },
    });

    await flushMicrotasks();

    const second = scheduler.enqueue({
      id: "second",
      priority: "background_write",
      timeoutMs: 2_000,
      execute: async () => {
        executed.push("second");
        return "second";
      },
    });

    const highPriority = scheduler.enqueue({
      id: "high",
      priority: "interactive_read",
      timeoutMs: 2_000,
      execute: async () => {
        executed.push("high");
        return "high";
      },
    });

    gate.resolve(undefined);

    await expect(Promise.all([first, second, highPriority])).resolves.toEqual([
      "first",
      "second",
      "high",
    ]);
    expect(executed).toEqual(["first", "high", "second"]);
  });

  it("rejects requests when the queue is full", async () => {
    const scheduler = new PriorityRequestScheduler(1, 1);
    const gate = deferred<void>();

    const first = scheduler.enqueue({
      id: "first",
      priority: "background_write",
      timeoutMs: 2_000,
      execute: async () => {
        await gate.promise;
        return "first";
      },
    });

    await flushMicrotasks();

    const second = scheduler.enqueue({
      id: "second",
      priority: "background_write",
      timeoutMs: 2_000,
      execute: async () => "second",
    });

    await expect(
      scheduler.enqueue({
        id: "third",
        priority: "interactive_read",
        timeoutMs: 2_000,
        execute: async () => "third",
      }),
    ).rejects.toBeInstanceOf(QueueFullError);

    gate.resolve(undefined);
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
  });

  it("times out queued requests that exceed their deadline before execution", async () => {
    const scheduler = new PriorityRequestScheduler(1, 2);
    const gate = deferred<void>();

    const first = scheduler.enqueue({
      id: "first",
      priority: "background_write",
      timeoutMs: 2_000,
      execute: async () => {
        await gate.promise;
        return "first";
      },
    });

    await flushMicrotasks();

    await expect(
      scheduler.enqueue({
        id: "timed-out",
        priority: "interactive_read",
        timeoutMs: 20,
        execute: async () => "timed-out",
      }),
    ).rejects.toBeInstanceOf(RequestTimeoutError);

    gate.resolve(undefined);
    await expect(first).resolves.toBe("first");
    expect(scheduler.stats().totalTimedOut).toBe(1);
  });

  it("drains outstanding work and rejects new requests once draining starts", async () => {
    const scheduler = new PriorityRequestScheduler(1, 2);
    const firstGate = deferred<void>();
    const executed: string[] = [];

    const first = scheduler.enqueue({
      id: "first",
      priority: "background_write",
      timeoutMs: 2_000,
      execute: async () => {
        executed.push("first");
        await firstGate.promise;
        return "first";
      },
    });

    await flushMicrotasks();

    const second = scheduler.enqueue({
      id: "second",
      priority: "interactive_read",
      timeoutMs: 2_000,
      execute: async () => {
        executed.push("second");
        return "second";
      },
    });

    const drainPromise = scheduler.drain();

    await expect(
      scheduler.enqueue({
        id: "third",
        priority: "admin",
        timeoutMs: 2_000,
        execute: async () => "third",
      }),
    ).rejects.toBeInstanceOf(ServerDrainingError);

    firstGate.resolve(undefined);

    await expect(Promise.all([first, second, drainPromise])).resolves.toEqual([
      "first",
      "second",
      undefined,
    ]);
    expect(executed).toEqual(["first", "second"]);
    expect(scheduler.stats().acceptingRequests).toBe(false);
  });
});
