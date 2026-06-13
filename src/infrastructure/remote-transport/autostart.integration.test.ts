import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@grpc/proto-loader", () => ({
  loadSync: vi.fn(() => ({})),
}));

vi.mock("@grpc/grpc-js", () => ({
  status: {
    INVALID_ARGUMENT: 3,
    DEADLINE_EXCEEDED: 4,
    RESOURCE_EXHAUSTED: 8,
    INTERNAL: 13,
    UNAVAILABLE: 14,
    UNAUTHENTICATED: 16,
  },
  Metadata: class {
    set(): void {}
    get(): string[] {
      return [];
    }
  },
  credentials: {
    createInsecure: () => ({}),
  },
  Server: class {},
  ServerCredentials: {
    createInsecure: () => ({}),
  },
  loadPackageDefinition: (definition: unknown) => definition,
}));

import type { LadybugClientConfig } from "../../platform/config/types.js";
import { DefaultAutostartManager } from "./autostart.js";
import { acquireCrossProcessLock } from "./autostart-runtime.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("AutostartManager — integration tests", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("14.4 multiple simultaneous clients coordinate through the lock so only one spawn occurs", async () => {
    const root = await mkdtemp(join(tmpdir(), "typocop-ladybug-autostart-"));
    const config: LadybugClientConfig = {
      runtimeMode: "client",
      prefix: "tpc_",
      dbPath: join(root, "db.ladybug"),
      serverUrl: "grpc://127.0.0.1:7617",
      authToken: "",
      autostart: true,
      startupTimeoutMs: 2_000,
      lockPath: join(root, "ladybug-server.lock"),
      discoveryPath: join(root, "ladybug-server.json"),
    };

    let healthy = false;
    let spawnCount = 0;
    const writeDiscovery = vi.fn().mockResolvedValue(undefined);

    const managers = Array.from({ length: 3 }, () =>
      new DefaultAutostartManager({
        checkHealth: vi.fn(async () => healthy),
        readDiscovery: vi.fn().mockResolvedValue(null),
        acquireLock: acquireCrossProcessLock,
        spawnServer: vi.fn(async () => {
          spawnCount++;
          await sleep(50);
          healthy = true;
          return { pid: 1_000 + spawnCount };
        }),
        writeDiscovery,
        sleep,
      }),
    );

    try {
      await Promise.all(managers.map((manager) => manager.ensureServer(config)));

      expect(spawnCount).toBe(1);
      expect(writeDiscovery).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
