import type { EmbeddedDatabaseRuntime } from "../runtime.js";

export interface HealthScheduler {
  isAcceptingRequests(): boolean;
}

/**
 * Server identity + liveness folded into Health/Admin responses (resilience
 * Phase F) so a supervisor can detect flapping (pid changes, uptime resets).
 */
export interface ServerInfo {
  readonly pid: number;
  readonly startedAt: string;
  readonly uptimeMs: () => number;
}

export function createHealthService(
  runtime: EmbeddedDatabaseRuntime,
  scheduler: HealthScheduler,
  serverInfo: ServerInfo,
): {
  readonly Check: (call: unknown, callback: (error: unknown, response?: unknown) => void) => void;
} {
  return {
    Check(_call, callback) {
      const serving = runtime.isHealthy() && scheduler.isAcceptingRequests();
      callback(null, {
        status: serving ? 1 : 2,
        message: serving ? "SERVING" : "NOT_SERVING",
        // Phase F (additive): identity + liveness.
        pid: serverInfo.pid,
        startedAt: serverInfo.startedAt,
        uptimeMs: serverInfo.uptimeMs(),
      });
    },
  };
}
