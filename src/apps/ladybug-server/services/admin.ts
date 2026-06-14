import { toServiceError } from "../../../infrastructure/remote-transport/errors.js";
import type { MetricsCollector } from "../metrics.js";
import type { SchedulerStats } from "../types.js";
import type { ServerInfo } from "./health.js";

export function createAdminService(options: {
  readonly metrics: MetricsCollector;
  readonly getSchedulerStats: () => SchedulerStats;
  readonly shutdown: (reason: string) => Promise<void>;
  readonly serverInfo: ServerInfo;
}): {
  readonly GetMetrics: (call: unknown, callback: (error: unknown, response?: unknown) => void) => Promise<void>;
  readonly Shutdown: (call: unknown, callback: (error: unknown, response?: unknown) => void) => Promise<void>;
} {
  return {
    async GetMetrics(_call, callback) {
      try {
        callback(null, {
          metrics: normalizeMetrics(options.metrics.getMetrics()),
          scheduler: normalizeScheduler(options.getSchedulerStats()),
          // Phase F (additive): identity + liveness.
          pid: options.serverInfo.pid,
          startedAt: options.serverInfo.startedAt,
          uptimeMs: options.serverInfo.uptimeMs(),
        });
      } catch (error) {
        callback(toServiceError(error));
      }
    },

    async Shutdown(_call, callback) {
      try {
        callback(null, { accepted: true });
        void options.shutdown("admin-shutdown");
      } catch (error) {
        callback(toServiceError(error));
      }
    },
  };
}

function normalizeMetrics(metrics: ReturnType<MetricsCollector["getMetrics"]>): Record<string, unknown> {
  return {
    uptimeMs: metrics.uptimeMs,
    dbOpen: metrics.dbOpen,
    inFlightRequests: metrics.inFlightRequests,
    queuedRequests: metrics.queuedRequests,
    requestCounts: metrics.requestCounts,
    errorCounts: metrics.errorCounts,
    latencyP50Ms: metrics.latencyP50Ms,
    latencyP99Ms: metrics.latencyP99Ms,
  };
}

function normalizeScheduler(stats: SchedulerStats): Record<string, unknown> {
  return {
    inFlight: stats.inFlight,
    queued: stats.queued,
    totalProcessed: stats.totalProcessed,
    totalTimedOut: stats.totalTimedOut,
    totalRejected: stats.totalRejected,
    acceptingRequests: stats.acceptingRequests,
  };
}
