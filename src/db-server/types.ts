export interface RequestMetadata {
  readonly requestId: string;
  readonly timeoutMs: number;
  readonly prefix: string;
}

// ErrorDetail and DiscoveryFile moved to infrastructure/remote-transport/types.ts
// (PR5) — both are shared transport types needed by client and server.

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
