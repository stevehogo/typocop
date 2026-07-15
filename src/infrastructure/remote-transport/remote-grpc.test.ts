import { describe, it, expect, vi } from "vitest";
import { waitForReadyWithRetry, createGrpcClientOptions } from "./remote-grpc.js";
import { GRPC_KEEPALIVE_TIME_MS, GRPC_SERVER_MIN_PING_INTERVAL_MS } from "../../platform/utils/limits.js";

/** Fake gRPC client whose `waitForReady` fails the first `failTimes` calls. */
function fakeClient(failTimes: number): {
  calls: number;
  waitForReady(deadline: Date, cb: (error?: Error | null) => void): void;
} {
  return {
    calls: 0,
    waitForReady(_deadline: Date, cb: (error?: Error | null) => void): void {
      this.calls++;
      if (this.calls <= failTimes) {
        cb(new Error("Failed to connect before the deadline"));
      } else {
        cb(null);
      }
    },
  };
}

const instantSleep = vi.fn().mockResolvedValue(undefined);

describe("createGrpcClientOptions", () => {
  it("sets keepalive so an idle channel stays warm through long compute gaps", () => {
    const opts = createGrpcClientOptions();
    expect(opts["grpc.keepalive_time_ms"]).toBe(GRPC_KEEPALIVE_TIME_MS);
    expect(opts["grpc.keepalive_timeout_ms"]).toBeGreaterThan(0);
    // permit_without_calls is essential: the idle gap has no active RPCs.
    expect(opts["grpc.keepalive_permit_without_calls"]).toBe(1);
    expect(opts["grpc.http2.max_pings_without_data"]).toBe(0);
    // still carries the message-size limits.
    expect(opts["grpc.max_receive_message_length"]).toBeGreaterThan(0);
  });

  it("client ping cadence is not tighter than the server's min ping interval (no GOAWAY)", () => {
    expect(GRPC_KEEPALIVE_TIME_MS).toBeGreaterThanOrEqual(GRPC_SERVER_MIN_PING_INTERVAL_MS);
  });
});

describe("waitForReadyWithRetry", () => {
  it("retries past transient connect failures and resolves once ready", async () => {
    const client = fakeClient(2); // fail twice, succeed on the 3rd attempt
    await expect(
      waitForReadyWithRetry(client, { perAttemptMs: 50, totalMs: 5_000, sleep: instantSleep }),
    ).resolves.toBeUndefined();
    expect(client.calls).toBe(3);
    expect(instantSleep).toHaveBeenCalled(); // backed off between attempts
  });

  it("succeeds on the first attempt without sleeping", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient(0);
    await waitForReadyWithRetry(client, { perAttemptMs: 50, totalMs: 5_000, sleep });
    expect(client.calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("throws the last error once the total budget is exhausted", async () => {
    const client = fakeClient(Number.POSITIVE_INFINITY); // never ready
    await expect(
      waitForReadyWithRetry(client, { perAttemptMs: 5, totalMs: 25, sleep: instantSleep }),
    ).rejects.toThrow(/Failed to connect before the deadline/);
    expect(client.calls).toBeGreaterThanOrEqual(1);
  });
});
