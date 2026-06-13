import { describe, expect, it, vi } from "vitest";
import * as fc from "fast-check";

vi.mock("@grpc/grpc-js", () => ({
  status: {
    DEADLINE_EXCEEDED: 4,
    RESOURCE_EXHAUSTED: 8,
    UNAVAILABLE: 14,
    INTERNAL: 13,
  },
}));

import { QueueFullError, RequestTimeoutError } from "../../infrastructure/remote-transport/errors.js";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const priorityRank: Record<"admin" | "interactive_read" | "background_write", number> = {
  admin: 0,
  interactive_read: 1,
  background_write: 2,
};

describe("PriorityRequestScheduler — property tests", () => {
  it("Property 4: inFlight never exceeds maxConcurrency", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.array(fc.integer({ min: 1, max: 10 }), { minLength: 4, maxLength: 12 }),
        async (maxConcurrency, durations) => {
          const scheduler = new PriorityRequestScheduler(
            maxConcurrency,
            durations.length + maxConcurrency,
          );

          let active = 0;
          let maxObserved = 0;

          await Promise.all(
            durations.map((duration, index) =>
              scheduler.enqueue({
                id: `req-${index}`,
                priority: "background_write",
                timeoutMs: 1_000,
                execute: async () => {
                  active++;
                  maxObserved = Math.max(maxObserved, active);
                  await sleep(duration);
                  active--;
                  return index;
                },
              }),
            ),
          );

          expect(maxObserved).toBeLessThanOrEqual(maxConcurrency);
        },
      ),
      { numRuns: 25 },
    );
  });

  it("Property 5: queue length never exceeds maxQueue and overflow requests are rejected", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 4 }),
        async (maxQueue, overflowCount) => {
          const scheduler = new PriorityRequestScheduler(1, maxQueue);
          const gate = deferred<void>();
          const accepted: Array<Promise<unknown>> = [];
          let maxQueued = 0;

          accepted.push(
            scheduler.enqueue({
              id: "running",
              priority: "background_write",
              timeoutMs: 1_000,
              execute: async () => {
                await gate.promise;
                return "running";
              },
            }),
          );

          await flushMicrotasks();

          for (let index = 0; index < maxQueue; index++) {
            accepted.push(
              scheduler.enqueue({
                id: `queued-${index}`,
                priority: "background_write",
                timeoutMs: 1_000,
                execute: async () => index,
              }),
            );
            maxQueued = Math.max(maxQueued, scheduler.stats().queued);
          }

          const rejected = await Promise.allSettled(
            Array.from({ length: overflowCount }, (_, index) =>
              scheduler.enqueue({
                id: `overflow-${index}`,
                priority: "interactive_read",
                timeoutMs: 1_000,
                execute: async () => index,
              }),
            ),
          );

          gate.resolve(undefined);
          await Promise.all(accepted);

          expect(maxQueued).toBeLessThanOrEqual(maxQueue);
          expect(scheduler.stats().queued).toBe(0);
          for (const result of rejected) {
            expect(result.status).toBe("rejected");
            expect((result as PromiseRejectedResult).reason).toBeInstanceOf(QueueFullError);
          }
        },
      ),
      { numRuns: 20 },
    );
  });

  it("Property 6: higher-priority queued requests execute before lower-priority ones", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.constantFrom("admin" as const, "interactive_read" as const, "background_write" as const),
          { minLength: 2, maxLength: 8 },
        ),
        async (priorities) => {
          const scheduler = new PriorityRequestScheduler(1, priorities.length + 2);
          const gate = deferred<void>();
          const executed: string[] = [];

          const first = scheduler.enqueue({
            id: "running",
            priority: "background_write",
            timeoutMs: 1_000,
            execute: async () => {
              executed.push("running");
              await gate.promise;
              return "running";
            },
          });

          await flushMicrotasks();

          const queued = priorities.map((priority, index) =>
            scheduler.enqueue({
              id: `queued-${index}`,
              priority,
              timeoutMs: 1_000,
              execute: async () => {
                executed.push(priority);
                return priority;
              },
            }),
          );

          gate.resolve(undefined);
          await Promise.all([first, ...queued]);

          const executedQueued = executed.slice(1);
          const expected = [...priorities].sort(
            (left, right) => priorityRank[left] - priorityRank[right],
          );
          expect(executedQueued).toEqual(expected);
        },
      ),
      { numRuns: 25 },
    );
  });

  it("Property 7: timed-out requests reject within timeout plus small overhead", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 10, max: 40 }), async (timeoutMs) => {
        const scheduler = new PriorityRequestScheduler(1, 2);
        const gate = deferred<void>();

        const running = scheduler.enqueue({
          id: "running",
          priority: "background_write",
          timeoutMs: 1_000,
          execute: async () => {
            await gate.promise;
            return "running";
          },
        });

        await flushMicrotasks();

        const startedAt = Date.now();
        await expect(
          scheduler.enqueue({
            id: "timed-out",
            priority: "interactive_read",
            timeoutMs,
            execute: async () => "timed-out",
          }),
        ).rejects.toBeInstanceOf(RequestTimeoutError);
        const elapsedMs = Date.now() - startedAt;

        gate.resolve(undefined);
        await running;

        expect(elapsedMs).toBeLessThanOrEqual(timeoutMs + 150);
      }),
      { numRuns: 20 },
    );
  });
});
