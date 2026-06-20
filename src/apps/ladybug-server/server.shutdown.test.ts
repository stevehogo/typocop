import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_GRPC_MAX_MESSAGE_BYTES } from "../../platform/utils/limits.js";

// ── Controllable gRPC mock ──────────────────────────────────────────────────
// Unlike the default test mock, tryShutdown here can be made to "hang" so the
// grace deadline → forceShutdown escalation (Phase B) is exercised.
const grpcState = {
  hangTryShutdown: false,
  forceShutdownCalls: 0,
  tryShutdownCalls: 0,
};

vi.mock("@grpc/proto-loader", () => ({
  loadSync: vi.fn(() => ({
    typocop: {
      ladybug: {
        v1: {
          Health: { service: { serviceName: "Health" } },
          Admin: { service: { serviceName: "Admin" } },
          Graph: { service: { serviceName: "Graph" } },
          Vector: { service: { serviceName: "Vector" } },
        },
      },
    },
  })),
}));

vi.mock("@grpc/grpc-js", () => {
  class FakeServer {
    addService(): void {}
    bindAsync(_address: string, _credentials: unknown, callback: (error: Error | null) => void): void {
      callback(null);
    }
    start(): void {}
    tryShutdown(callback: () => void): void {
      grpcState.tryShutdownCalls++;
      if (grpcState.hangTryShutdown) {
        return; // never calls back → forces the grace timeout escalation
      }
      callback();
    }
    forceShutdown(): void {
      grpcState.forceShutdownCalls++;
    }
  }
  return {
    status: { UNAVAILABLE: 14, INTERNAL: 13 },
    Server: FakeServer,
    ServerCredentials: { createInsecure: () => ({}) },
    loadPackageDefinition: (d: unknown) => d,
  };
});

// ── Controllable runtime mock ───────────────────────────────────────────────
const runtimeState = {
  hangClose: false,
  rejectClose: false,
  closeCalls: 0,
  healthy: true,
};

vi.mock("./runtime.js", () => {
  class FakeRuntime {
    async open(): Promise<void> {}
    getConnection(): unknown { return {}; }
    getDatabase(): unknown { return {}; }
    isHealthy(): boolean { return runtimeState.healthy; }
    async close(): Promise<void> {
      runtimeState.closeCalls++;
      runtimeState.healthy = false;
      if (runtimeState.hangClose) {
        await new Promise<void>(() => {}); // never resolves
      }
      if (runtimeState.rejectClose) {
        throw new Error("close boom");
      }
    }
  }
  return { LadybugEmbeddedDatabaseRuntime: FakeRuntime };
});

// Spy discovery + lock removal so Phase C "cleanup even on failure" is provable.
const discoverySpies = vi.hoisted(() => ({ removeAsync: 0, removeSync: 0 }));
vi.mock("../../infrastructure/remote-transport/discovery.js", () => ({
  writeDiscoveryFile: vi.fn(async () => {}),
  readDiscoveryFile: vi.fn(async () => null),
  removeDiscoveryFile: vi.fn(async () => { discoverySpies.removeAsync++; }),
  removeDiscoveryFileSync: vi.fn(() => { discoverySpies.removeSync++; }),
}));

const lockSpies = vi.hoisted(() => ({ releaseSync: 0 }));
vi.mock("../../infrastructure/persistence/file-lock.js", () => ({
  releaseFileLockSync: vi.fn(() => { lockSpies.releaseSync++; }),
}));

import { startConnectionServer } from "./server.js";

let port = 8700;
function baseConfig(dbPath: string, discoveryPath: string, overrides: Record<string, unknown> = {}) {
  return {
    runtimeMode: "server" as const,
    prefix: "tpc_",
    dbPath,
    host: "127.0.0.1",
    port: port++,
    authToken: "",
    grpcMaxMessageBytes: DEFAULT_GRPC_MAX_MESSAGE_BYTES,
    maxConcurrency: 2,
    maxQueue: 8,
    idleTtlMs: 0,
    discoveryPath,
    shutdownGraceMs: 50,
    shutdownHardMs: 200,
    lockStaleMs: 30_000,
    lockRetries: 10,
    ...overrides,
  };
}

describe("startConnectionServer — bounded shutdown (Phase B/C)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    grpcState.hangTryShutdown = false;
    grpcState.forceShutdownCalls = 0;
    grpcState.tryShutdownCalls = 0;
    runtimeState.hangClose = false;
    runtimeState.rejectClose = false;
    runtimeState.closeCalls = 0;
    runtimeState.healthy = true;
    discoverySpies.removeAsync = 0;
    discoverySpies.removeSync = 0;
    lockSpies.releaseSync = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");
    process.removeAllListeners("exit");
  });

  it("escalates to forceShutdown after the grace deadline when tryShutdown hangs", async () => {
    const root = await mkdtemp(join(tmpdir(), "typocop-shutdown-"));
    const server = await startConnectionServer(
      baseConfig(join(root, "db.ladybug"), join(root, "disc.json")),
    );
    grpcState.hangTryShutdown = true;

    const start = Date.now();
    await server.shutdown("test");
    const elapsed = Date.now() - start;

    expect(grpcState.tryShutdownCalls).toBe(1);
    expect(grpcState.forceShutdownCalls).toBe(1);
    expect(elapsed).toBeLessThan(1_000);
    await rm(root, { recursive: true, force: true });
  });

  it("completes within ~shutdownHardMs when runtime.close hangs, and still cleans up", async () => {
    const root = await mkdtemp(join(tmpdir(), "typocop-shutdown-"));
    const server = await startConnectionServer(
      baseConfig(join(root, "db.ladybug"), join(root, "disc.json")),
    );
    runtimeState.hangClose = true;

    const start = Date.now();
    await server.shutdown("test");
    const elapsed = Date.now() - start;

    // Bounded by shutdownHardMs (200ms) + small overhead, never hangs forever.
    expect(elapsed).toBeLessThan(2_000);
    // Phase C: discovery removed and lock released even though close timed out.
    expect(discoverySpies.removeAsync).toBeGreaterThanOrEqual(1);
    expect(lockSpies.releaseSync).toBe(1);
    await rm(root, { recursive: true, force: true });
  });

  it("removes discovery and releases the lock even if runtime.close rejects", async () => {
    const root = await mkdtemp(join(tmpdir(), "typocop-shutdown-"));
    const server = await startConnectionServer(
      baseConfig(join(root, "db.ladybug"), join(root, "disc.json")),
    );
    runtimeState.rejectClose = true;

    // A failing DB close is logged and swallowed: shutdown still completes and
    // Phase C cleanup (discovery removal + lock release) runs in the finally.
    await server.shutdown("test");

    expect(runtimeState.closeCalls).toBe(1);
    expect(discoverySpies.removeAsync).toBeGreaterThanOrEqual(1);
    expect(lockSpies.releaseSync).toBe(1);
    await rm(root, { recursive: true, force: true });
  });

  it("a clean shutdown (no in-flight work) is fast and never force-shuts", async () => {
    const root = await mkdtemp(join(tmpdir(), "typocop-shutdown-"));
    const server = await startConnectionServer(
      baseConfig(join(root, "db.ladybug"), join(root, "disc.json")),
    );

    const start = Date.now();
    await server.shutdown("test");
    const elapsed = Date.now() - start;

    expect(grpcState.forceShutdownCalls).toBe(0);
    expect(elapsed).toBeLessThan(200);
    expect(runtimeState.closeCalls).toBe(1);
    await rm(root, { recursive: true, force: true });
  });
});
