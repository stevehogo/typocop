/**
 * Shared transport types — needed by both the gRPC client (remote-transport)
 * and server (apps/ladybug-server). Dropped down here from db-server/types.ts
 * so neither side imports the other (TARGET-ARCHITECTURE §4.3, §5.3).
 */

/** Structured error payload carried over the wire. */
export interface ErrorDetail {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** Contents of the on-disk server discovery file. */
export interface DiscoveryFile {
  readonly pid: number;
  readonly startedAt: string;
  readonly prefix: string;
  readonly dbPath: string;
  readonly url: string;
}
