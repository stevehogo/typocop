import type { SchedulerStats, ServerMetrics } from "./types.js";

type RequestStatus = "ok" | "error" | "timeout";

export interface MetricsCollector {
  recordRequest(endpoint: string, durationMs: number, status: RequestStatus): void;
  getMetrics(): ServerMetrics;
}

export interface MetricsCollectorOptions {
  readonly isDatabaseOpen: () => boolean;
  readonly getSchedulerStats: () => SchedulerStats;
}

export class InMemoryMetricsCollector implements MetricsCollector {
  private readonly startedAt = Date.now();
  private readonly requestCounts = new Map<string, number>();
  private readonly errorCounts = new Map<string, number>();
  private readonly latencies = new Map<string, number[]>();

  constructor(private readonly options: MetricsCollectorOptions) {}

  recordRequest(endpoint: string, durationMs: number, status: RequestStatus): void {
    this.requestCounts.set(endpoint, (this.requestCounts.get(endpoint) || 0) + 1);
    if (status !== "ok") {
      this.errorCounts.set(endpoint, (this.errorCounts.get(endpoint) || 0) + 1);
    }
    const samples = this.latencies.get(endpoint) || [];
    samples.push(durationMs);
    if (samples.length > 2048) {
      samples.shift();
    }
    this.latencies.set(endpoint, samples);
  }

  getMetrics(): ServerMetrics {
    const scheduler = this.options.getSchedulerStats();
    return {
      uptimeMs: Date.now() - this.startedAt,
      dbOpen: this.options.isDatabaseOpen(),
      inFlightRequests: scheduler.inFlight,
      queuedRequests: scheduler.queued,
      requestCounts: Object.fromEntries(this.requestCounts),
      errorCounts: Object.fromEntries(this.errorCounts),
      latencyP50Ms: this.buildPercentiles(0.5),
      latencyP99Ms: this.buildPercentiles(0.99),
    };
  }

  private buildPercentiles(percentile: number): Record<string, number> {
    return Object.fromEntries(
      Array.from(this.latencies.entries()).map(([endpoint, values]) => [
        endpoint,
        percentileValue(values, percentile),
      ]),
    );
  }
}

function percentileValue(values: readonly number[], percentile: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * percentile) - 1),
  );
  return sorted[index] ?? 0;
}
