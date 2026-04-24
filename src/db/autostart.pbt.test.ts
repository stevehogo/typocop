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

import type { LadybugClientConfig } from "../config/types.js";
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

        const healthAnswers =
          scenario === "already-healthy"
            ? [false, true]
            : scenario === "success"
              ? [false, false, true]
              : [false, false, false, false, false, false];
        const checkHealth = vi
          .fn<(...args: unknown[]) => Promise<boolean>>()
          .mockImplementation(async () => healthAnswers.shift() ?? false);

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
        const now = vi.fn(() => nowValues.shift() ?? 1_500);

        const manager = new DefaultAutostartManager({
          checkHealth,
          readDiscovery: vi.fn().mockResolvedValue(null),
          acquireLock: vi.fn().mockResolvedValue(release),
          spawnServer,
          writeDiscovery,
          sleep,
          now,
        });

        if (scenario === "success" || scenario === "already-healthy") {
          await expect(manager.ensureServer(baseConfig)).resolves.toBeUndefined();
        } else {
          await expect(manager.ensureServer(baseConfig)).rejects.toBeDefined();
        }

        expect(release).toHaveBeenCalledOnce();
      }),
      { numRuns: 25 },
    );
  });
});
