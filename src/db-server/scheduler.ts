import { QueueFullError, RequestTimeoutError, ServerDrainingError } from "./errors.js";
import { logServerEvent } from "../platform/logging/logger.js";
import type { RequestPriority, ScheduledRequest, SchedulerStats } from "./types.js";

export interface RequestScheduler {
  enqueue<T>(request: ScheduledRequest<T>): Promise<T>;
  drain(): Promise<void>;
  stats(): SchedulerStats;
}

interface PendingRequest<T> extends ScheduledRequest<T> {
  readonly enqueuedAt: number;
  timedOut: boolean;
  started: boolean;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

const PRIORITY_ORDER: readonly RequestPriority[] = [
  "admin",
  "interactive_read",
  "background_write",
] as const;

export class PriorityRequestScheduler implements RequestScheduler {
  private readonly queue: PendingRequest<unknown>[] = [];
  private inFlight = 0;
  private totalProcessed = 0;
  private totalTimedOut = 0;
  private totalRejected = 0;
  private draining = false;
  private drainResolvers: Array<() => void> = [];

  constructor(
    private readonly maxConcurrency: number,
    private readonly maxQueue: number,
  ) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error(`maxConcurrency must be a positive integer, received ${maxConcurrency}`);
    }
    if (!Number.isInteger(maxQueue) || maxQueue < 1) {
      throw new Error(`maxQueue must be a positive integer, received ${maxQueue}`);
    }
  }

  async enqueue<T>(request: ScheduledRequest<T>): Promise<T> {
    if (this.draining) {
      this.totalRejected++;
      logServerEvent("warn", "request_rejected", {
        requestId: request.id,
        reason: "scheduler_draining",
      });
      throw new ServerDrainingError();
    }
    if (this.queue.length >= this.maxQueue) {
      this.totalRejected++;
      logServerEvent("warn", "queue_saturated", {
        requestId: request.id,
        queued: this.queue.length,
        maxQueue: this.maxQueue,
      });
      throw new QueueFullError(this.maxQueue);
    }

    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest<T> = {
        ...request,
        enqueuedAt: Date.now(),
        timedOut: false,
        started: false,
        resolve,
        reject,
        timer: setTimeout(() => {
          pending.timedOut = true;
          this.totalTimedOut++;
          logServerEvent("warn", "request_timeout", {
            requestId: pending.id,
            timeoutMs: pending.timeoutMs,
          });
          if (!pending.started) {
            this.removeFromQueue(pending.id);
          }
          pending.reject(new RequestTimeoutError(pending.id, pending.timeoutMs));
          this.flushDrainWaiters();
        }, request.timeoutMs),
      };

      this.insertByPriority(pending as PendingRequest<unknown>);
      this.tryExecuteNext();
    });
  }

  async drain(): Promise<void> {
    this.draining = true;
    logServerEvent("info", "scheduler_draining");
    if (this.inFlight === 0 && this.queue.length === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  stats(): SchedulerStats {
    return {
      inFlight: this.inFlight,
      queued: this.queue.length,
      totalProcessed: this.totalProcessed,
      totalTimedOut: this.totalTimedOut,
      totalRejected: this.totalRejected,
      acceptingRequests: !this.draining,
    };
  }

  isAcceptingRequests(): boolean {
    return !this.draining;
  }

  private insertByPriority(request: PendingRequest<unknown>): void {
    const requestPriority = PRIORITY_ORDER.indexOf(request.priority);
    const insertAt = this.queue.findIndex((queued) =>
      PRIORITY_ORDER.indexOf(queued.priority) > requestPriority,
    );
    if (insertAt === -1) {
      this.queue.push(request);
      return;
    }
    this.queue.splice(insertAt, 0, request);
  }

  private removeFromQueue(requestId: string): void {
    const index = this.queue.findIndex((request) => request.id === requestId);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
  }

  private tryExecuteNext(): void {
    while (this.inFlight < this.maxConcurrency && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next || next.timedOut) {
        continue;
      }

      next.started = true;
      this.inFlight++;
      this.totalProcessed++;

      next.execute()
        .then((result) => {
          if (!next.timedOut) {
            clearTimeout(next.timer);
            next.resolve(result);
          }
        })
        .catch((error: unknown) => {
          if (!next.timedOut) {
            clearTimeout(next.timer);
            next.reject(error);
          }
        })
        .finally(() => {
          this.inFlight--;
          this.tryExecuteNext();
          this.flushDrainWaiters();
        });
    }
  }

  private flushDrainWaiters(): void {
    if (this.inFlight !== 0 || this.queue.length !== 0) {
      return;
    }
    const waiters = this.drainResolvers;
    this.drainResolvers = [];
    for (const resolve of waiters) {
      resolve();
    }
  }
}
