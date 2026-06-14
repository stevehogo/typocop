/**
 * Phase D — self-healing startup: stale-discovery reclaim.
 *
 * `reclaimStaleDiscovery` inspects an existing discovery file before the server
 * overwrites it: a dead pid is logged as reclaimed; a live pid is logged but
 * still allowed (the new server now owns the lock). It must never throw.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscoveryFile } from "../../infrastructure/remote-transport/types.js";

const logServerEvent = vi.fn();

vi.mock("../../platform/logging/logger.js", () => ({
  logServerEvent: (...args: unknown[]) => logServerEvent(...args),
}));

import { reclaimStaleDiscovery } from "./server.js";

const baseDiscovery: DiscoveryFile = {
  pid: 4242,
  startedAt: "2026-06-14T00:00:00.000Z",
  prefix: "test",
  dbPath: "/tmp/db.ladybug",
  url: "grpc://127.0.0.1:50051",
};

describe("reclaimStaleDiscovery", () => {
  beforeEach(() => {
    logServerEvent.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a reclaim (info) when the recorded pid is dead", async () => {
    const readDiscovery = vi.fn().mockResolvedValue(baseDiscovery);
    const pidAlive = vi.fn().mockReturnValue(false);

    await reclaimStaleDiscovery("/tmp/discovery.json", readDiscovery, pidAlive);

    expect(pidAlive).toHaveBeenCalledWith(4242);
    expect(logServerEvent).toHaveBeenCalledWith(
      "info",
      "discovery_reclaimed_stale",
      expect.objectContaining({ pid: 4242, discoveryPath: "/tmp/discovery.json" }),
    );
  });

  it("does NOT log a reclaim when there is no existing discovery file", async () => {
    const readDiscovery = vi.fn().mockResolvedValue(null);
    const pidAlive = vi.fn();

    await reclaimStaleDiscovery("/tmp/discovery.json", readDiscovery, pidAlive);

    expect(pidAlive).not.toHaveBeenCalled();
    expect(logServerEvent).not.toHaveBeenCalled();
  });

  it("warns but does not treat a live pid as stale (no misbehavior)", async () => {
    const readDiscovery = vi.fn().mockResolvedValue(baseDiscovery);
    const pidAlive = vi.fn().mockReturnValue(true);

    await reclaimStaleDiscovery("/tmp/discovery.json", readDiscovery, pidAlive);

    expect(pidAlive).toHaveBeenCalledWith(4242);
    expect(logServerEvent).toHaveBeenCalledWith(
      "warn",
      "discovery_overwrite_live_pid",
      expect.objectContaining({ pid: 4242 }),
    );
    expect(logServerEvent).not.toHaveBeenCalledWith(
      "info",
      "discovery_reclaimed_stale",
      expect.anything(),
    );
  });

  it("never throws if the read fails; logs a best-effort warning", async () => {
    const readDiscovery = vi.fn().mockRejectedValue(new Error("read boom"));
    const pidAlive = vi.fn();

    await expect(
      reclaimStaleDiscovery("/tmp/discovery.json", readDiscovery, pidAlive),
    ).resolves.toBeUndefined();

    expect(logServerEvent).toHaveBeenCalledWith(
      "warn",
      "discovery_reclaim_check_failed",
      expect.objectContaining({ discoveryPath: "/tmp/discovery.json" }),
    );
  });
});
