import type { EmbeddedDatabaseRuntime } from "../runtime.js";

export interface HealthScheduler {
  isAcceptingRequests(): boolean;
}

export function createHealthService(
  runtime: EmbeddedDatabaseRuntime,
  scheduler: HealthScheduler,
): {
  readonly Check: (call: unknown, callback: (error: unknown, response?: unknown) => void) => void;
} {
  return {
    Check(_call, callback) {
      const serving = runtime.isHealthy() && scheduler.isAcceptingRequests();
      callback(null, {
        status: serving ? 1 : 2,
        message: serving ? "SERVING" : "NOT_SERVING",
      });
    },
  };
}
