import { describe, expect, it, vi } from "vitest";
import * as fc from "fast-check";

vi.mock("@grpc/proto-loader", () => ({
  loadSync: vi.fn(() => ({})),
}));

vi.mock("@grpc/grpc-js", () => ({
  status: {
    UNAVAILABLE: 14,
    DEADLINE_EXCEEDED: 4,
    RESOURCE_EXHAUSTED: 8,
  },
  Metadata: class {
    set(): void {}
  },
  credentials: {
    createInsecure: () => ({}),
  },
  loadPackageDefinition: (definition: unknown) => definition,
}));

import type { LadybugClientConfig } from "../platform/config/types.js";
import { DefaultAutostartManager } from "./autostart.js";

const baseConfig: LadybugClientConfig = {
  runtimeMode: "client",
  prefix: "tpc_",
  dbPath: "/tmp/db.ladybug",
  serverUrl: "grpc://127.0.0.1:7617",
  authToken: "",
  autostart: true,
  startupTimeoutMs: 1_000,
  lockPath: "/tmp/server.lock",
  discoveryPath: "/tmp/discovery.json",
};

describe("DefaultAutostartManager — property tests", () => {
  it("Property 9: acquired locks are always released, even when autostart fails", async () => {
    const scenarioArb = fc.constantFrom(
      "already-healthy" as const,
      "healthy-prefix-mismatch" as const,
      "spawn-fails" as const,
      "write-fails" as const,
      "timeout" as const,
      "success" as const,
    );

    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const release = vi.fn().mockResolvedValue(undefined);
        const writeDiscovery = vi.fn().mockResolvedValue(undefined);
        const spawnServer = vi.fn().mockResolvedValue({ pid: 42 });
        const sleep = vi.fn().mockResolvedValue(undefined);
        const killPid = vi.fn();

        const healthAnswers =
          scenario === "already-healthy"
            ? [false, true]
          : scenario === "healthy-prefix-mismatch"
              // 1) healthy before termination attempt
              // 2) still healthy after acquiring lock
              // 3) becomes unhealthy after killing the mismatched server
              // 4) still unhealthy when acquiring the spawn lock
              // 5) becomes healthy after spawn
              ? [true, true, false, false, true]
            : scenario === "success"
              ? [false, false, true]
              : [false, false, false, false, false, false];
        const checkHealth = vi
          .fn<(...args: unknown[]) => Promise<boolean>>()
          .mockImplementation(async () => {
            const next = healthAnswers.shift();
            if (typeof next === "boolean") return next;
            // For the prefix-mismatch scenario, extra health checks can occur due to polling loops.
            // Default to "healthy" once the scripted sequence is exhausted so we don't fail by timeout.
            return scenario === "healthy-prefix-mismatch" ? true : false;
          });

        if (scenario === "spawn-fails") {
          spawnServer.mockRejectedValue(new Error("spawn failed"));
        }
        if (scenario === "write-fails") {
          writeDiscovery.mockRejectedValue(new Error("write failed"));
        }

        const nowValues =
          scenario === "timeout"
            ? [0, 0, 250, 500, 750, 1_000]
            : [0, 0, 200];
        const now =
          scenario === "healthy-prefix-mismatch"
            ? vi.fn(() => 0)
            : vi.fn(() => nowValues.shift() ?? 1_500);

        const manager = new DefaultAutostartManager({
          checkHealth,
          readDiscovery: vi.fn().mockImplementation(async (path: string) => {
            if (scenario === "healthy-prefix-mismatch") {
              return {
                pid: 4242,
                startedAt: "2026-01-01T00:00:00.000Z",
                prefix: "teravexa_",
                dbPath: "/tmp/db.ladybug",
                // Simulate a common mismatch: server binds to 0.0.0.0 but the client uses 127.0.0.1.
                url: "grpc://0.0.0.0:7617",
              };
            }
            return null;
          }),
          acquireLock: vi.fn().mockResolvedValue(release),
          spawnServer,
          writeDiscovery,
          sleep,
          now,
          killPid,
          listDiscoveryFiles: vi.fn().mockResolvedValue([
            "/home/user/.typocop/teravexa_/ladybug-server.json",
          ]),
        });

        if (scenario === "success" || scenario === "already-healthy" || scenario === "healthy-prefix-mismatch") {
          await expect(manager.ensureServer(baseConfig)).resolves.toBeUndefined();
        } else {
          await expect(manager.ensureServer(baseConfig)).rejects.toBeDefined();
        }

        if (scenario === "healthy-prefix-mismatch") {
          // One lock for termination, one for spawn path.
          expect(release).toHaveBeenCalledTimes(2);
          expect(killPid).toHaveBeenCalled();
          expect(spawnServer).toHaveBeenCalled();
        } else {
          expect(release).toHaveBeenCalledOnce();
        }
      }),
      { numRuns: 25 },
    );
  });
});
