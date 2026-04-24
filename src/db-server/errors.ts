import type { ErrorDetail } from "./types.js";

const GRPC_STATUS = {
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  RESOURCE_EXHAUSTED: 8,
  INTERNAL: 13,
  UNAVAILABLE: 14,
} as const;

interface GrpcMappableError extends Error {
  readonly grpcStatus?: number;
  readonly code?: number;
  readonly errorCode?: string;
  readonly retryable?: boolean;
}

export class ServerUnavailableError extends Error {
  readonly grpcStatus = GRPC_STATUS.UNAVAILABLE;
  readonly errorCode = "SERVER_UNAVAILABLE";
  readonly retryable = true;

  constructor(public readonly serverUrl: string) {
    super(`Connection server is unavailable at ${serverUrl}`);
    this.name = "ServerUnavailableError";
  }
}

export class ServerStartupTimeoutError extends Error {
  readonly errorCode = "SERVER_STARTUP_TIMEOUT";
  readonly retryable = true;

  constructor(public readonly timeoutMs: number) {
    super(`Connection server did not become ready within ${timeoutMs}ms`);
    this.name = "ServerStartupTimeoutError";
  }
}

export class QueueFullError extends Error {
  readonly grpcStatus = GRPC_STATUS.RESOURCE_EXHAUSTED;
  readonly errorCode = "QUEUE_FULL";
  readonly retryable = true;

  constructor(public readonly maxQueue: number) {
    super(`Connection server queue is full (maxQueue=${maxQueue})`);
    this.name = "QueueFullError";
  }
}

export class RequestTimeoutError extends Error {
  readonly grpcStatus = GRPC_STATUS.DEADLINE_EXCEEDED;
  readonly errorCode = "REQUEST_TIMEOUT";
  readonly retryable = true;

  constructor(
    public readonly requestId: string,
    public readonly timeoutMs: number,
  ) {
    super(`Request ${requestId} timed out after ${timeoutMs}ms`);
    this.name = "RequestTimeoutError";
  }
}

export class ServerDrainingError extends Error {
  readonly grpcStatus = GRPC_STATUS.UNAVAILABLE;
  readonly errorCode = "SERVER_DRAINING";
  readonly retryable = true;

  constructor() {
    super("Connection server is draining and no longer accepts new requests");
    this.name = "ServerDrainingError";
  }
}

export function toErrorDetail(error: unknown): ErrorDetail {
  const message = error instanceof Error ? error.message : String(error);
  const grpcError = error as GrpcMappableError;
  return {
    code: grpcError.errorCode || "INTERNAL_ERROR",
    message,
    retryable: grpcError.retryable ?? false,
  };
}

export function toGrpcStatusCode(error: unknown): number {
  const grpcError = error as GrpcMappableError;
  return grpcError.grpcStatus ?? grpcError.code ?? GRPC_STATUS.INTERNAL;
}

export function toServiceError(error: unknown): Error & {
  readonly code: number;
  readonly details: string;
  readonly metadata?: unknown;
} {
  const detail = toErrorDetail(error);
  const serviceError = new Error(detail.message) as Error & {
    readonly code: number;
    readonly details: string;
    readonly metadata?: unknown;
  };
  serviceError.name = error instanceof Error ? error.name : "Error";
  Object.assign(serviceError, {
    code: toGrpcStatusCode(error),
    details: JSON.stringify(detail),
  });
  return serviceError;
}
