export interface RequestMetadata {
  readonly requestId: string;
  readonly timeoutMs: number;
  readonly prefix: string;
}

export interface ErrorDetail {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface DiscoveryFile {
  readonly pid: number;
  readonly startedAt: string;
  readonly prefix: string;
  readonly dbPath: string;
  readonly url: string;
}

export type RequestPriority = "admin" | "interactive_read" | "background_write";

export interface ScheduledRequest<T> {
  readonly id: string;
  readonly priority: RequestPriority;
  readonly timeoutMs: number;
  readonly execute: () => Promise<T>;
}

export interface SchedulerStats {
  readonly inFlight: number;
  readonly queued: number;
  readonly totalProcessed: number;
  readonly totalTimedOut: number;
  readonly totalRejected: number;
  readonly acceptingRequests: boolean;
}

export interface ServerMetrics {
  readonly uptimeMs: number;
  readonly dbOpen: boolean;
  readonly inFlightRequests: number;
  readonly queuedRequests: number;
  readonly requestCounts: Readonly<Record<string, number>>;
  readonly errorCounts: Readonly<Record<string, number>>;
  readonly latencyP50Ms: Readonly<Record<string, number>>;
  readonly latencyP99Ms: Readonly<Record<string, number>>;
}
