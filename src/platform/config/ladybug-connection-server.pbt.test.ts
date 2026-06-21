import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fc from "fast-check";

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/mock-home"),
}));

import { ConfigurationManager } from "./configuration-manager.js";
import { LadybugConfigError } from "./errors.js";
import { DEFAULT_GRPC_MAX_MESSAGE_BYTES, GRPC_MAX_MESSAGE_BYTES_ENV } from "../utils/limits.js";

const originalEnv = process.env;
const customLadybugEnv = {
  LADYBUG_RUNTIME_MODE: "client",
  LADYBUG_SERVER_URL: "grpc://10.0.0.9:8123",
  LADYBUG_SERVER_HOST: "10.0.0.9",
  LADYBUG_SERVER_PORT: "8123",
  LADYBUG_SERVER_AUTH_TOKEN: "secret-token",
  LADYBUG_GRPC_MAX_MESSAGE_BYTES: "8388608",
  LADYBUG_SERVER_MAX_CONCURRENCY: "9",
  LADYBUG_SERVER_MAX_QUEUE: "128",
  LADYBUG_SERVER_AUTOSTART: "true",
  LADYBUG_SERVER_STARTUP_TIMEOUT_MS: "54321",
  LADYBUG_SERVER_IDLE_TTL_MS: "777",
} as const;

const ladybugDefaults = {
  runtimeMode: "server",
  serverUrl: "grpc://127.0.0.1:7617",
  serverHost: "127.0.0.1",
  serverPort: 7617,
  serverAuthToken: "",
  grpcMaxMessageBytes: DEFAULT_GRPC_MAX_MESSAGE_BYTES,
  serverMaxConcurrency: 4,
  serverMaxQueue: 256,
  serverAutostart: false,
  serverStartupTimeoutMs: 30_000,
  serverIdleTtlMs: 0,
} as const;

const envKeyArb = fc.constantFrom<keyof typeof customLadybugEnv>(
  "LADYBUG_RUNTIME_MODE",
  "LADYBUG_SERVER_URL",
  "LADYBUG_SERVER_HOST",
  "LADYBUG_SERVER_PORT",
  "LADYBUG_SERVER_AUTH_TOKEN",
  GRPC_MAX_MESSAGE_BYTES_ENV,
  "LADYBUG_SERVER_MAX_CONCURRENCY",
  "LADYBUG_SERVER_MAX_QUEUE",
  "LADYBUG_SERVER_AUTOSTART",
  "LADYBUG_SERVER_STARTUP_TIMEOUT_MS",
  "LADYBUG_SERVER_IDLE_TTL_MS",
);

const validPrefixArb = fc
  .tuple(
    fc.constantFrom(...("abcdefghijklmnopqrstuvwxyz" as const)),
    fc.array(fc.constantFrom(...("abcdefghijklmnopqrstuvwxyz0123456789" as const)), {
      maxLength: 7,
    }),
  )
  .map(([first, rest]) => `${first}${rest.join("")}_`);

describe("Ladybug connection-server configuration — property tests", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("Property 2: invalid serverUrl, port, maxConcurrency, and maxQueue are rejected", async () => {
    const invalidConfigArb = fc.oneof(
      fc.record({
        field: fc.constant("LADYBUG_SERVER_URL" as const),
        value: fc.oneof(
          fc.string().filter((value) => {
            try {
              const parsed = new URL(value);
              return parsed.protocol !== "grpc:";
            } catch {
              return value.length > 0;
            }
          }),
          fc.constant("http://127.0.0.1:7617"),
        ),
        runtimeMode: fc.constant("client" as const),
      }),
      fc.record({
        field: fc.constant("LADYBUG_SERVER_PORT" as const),
        value: fc.oneof(
          fc.integer({ max: 0 }).map(String),
          fc.integer({ min: 65_536, max: 90_000 }).map(String),
          fc.constant("3.14"),
        ),
        runtimeMode: fc.constant("server" as const),
      }),
      fc.record({
        field: fc.constant("LADYBUG_SERVER_MAX_CONCURRENCY" as const),
        value: fc.oneof(
          fc.integer({ max: 0 }).map(String),
          fc.constant("1.5"),
          fc.constant("NaN"),
        ),
        runtimeMode: fc.constant("server" as const),
      }),
      fc.record({
        field: fc.constant(GRPC_MAX_MESSAGE_BYTES_ENV),
        value: fc.oneof(
          fc.integer({ max: 0 }).map(String),
          fc.constant("1.5"),
          fc.constant("NaN"),
        ),
        runtimeMode: fc.constant("server" as const),
      }),
      fc.record({
        field: fc.constant("LADYBUG_SERVER_MAX_QUEUE" as const),
        value: fc.oneof(
          fc.integer({ max: 0 }).map(String),
          fc.constant("2.5"),
          fc.constant("NaN"),
        ),
        runtimeMode: fc.constant("server" as const),
      }),
    );

    await fc.assert(
      fc.asyncProperty(invalidConfigArb, async ({ field, value, runtimeMode }) => {
        process.env = {
          ...originalEnv,
          TYPOCOP_PREFIX: "tenant_",
          LADYBUG_RUNTIME_MODE: runtimeMode,
          [field]: value,
        };

        const manager = new ConfigurationManager();
        await expect(manager.initialize()).rejects.toBeInstanceOf(LadybugConfigError);
      }),
      { numRuns: 40 },
    );
  });

  it("Property 3: missing env vars resolve to documented defaults", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(envKeyArb, { maxLength: 10 }), async (missingKeys) => {
        process.env = {
          ...originalEnv,
          TYPOCOP_PREFIX: "tenant_",
          ...customLadybugEnv,
        };
        for (const key of missingKeys) {
          delete process.env[key];
        }

        const manager = new ConfigurationManager();
        await manager.initialize();
        const config = manager.getConfiguration().ladybugdb;

        expect(config.runtimeMode).toBe(
          missingKeys.includes("LADYBUG_RUNTIME_MODE")
            ? ladybugDefaults.runtimeMode
            : customLadybugEnv.LADYBUG_RUNTIME_MODE,
        );
        expect(config.serverUrl).toBe(
          missingKeys.includes("LADYBUG_SERVER_URL")
            ? ladybugDefaults.serverUrl
            : customLadybugEnv.LADYBUG_SERVER_URL,
        );
        expect(config.serverHost).toBe(
          missingKeys.includes("LADYBUG_SERVER_HOST")
            ? ladybugDefaults.serverHost
            : customLadybugEnv.LADYBUG_SERVER_HOST,
        );
        expect(config.serverPort).toBe(
          missingKeys.includes("LADYBUG_SERVER_PORT")
            ? ladybugDefaults.serverPort
            : Number(customLadybugEnv.LADYBUG_SERVER_PORT),
        );
        expect(config.serverAuthToken).toBe(
          missingKeys.includes("LADYBUG_SERVER_AUTH_TOKEN")
            ? ladybugDefaults.serverAuthToken
            : customLadybugEnv.LADYBUG_SERVER_AUTH_TOKEN,
        );
        expect(config.grpcMaxMessageBytes).toBe(
          missingKeys.includes(GRPC_MAX_MESSAGE_BYTES_ENV)
            ? ladybugDefaults.grpcMaxMessageBytes
            : Number(customLadybugEnv.LADYBUG_GRPC_MAX_MESSAGE_BYTES),
        );
        expect(config.serverMaxConcurrency).toBe(
          missingKeys.includes("LADYBUG_SERVER_MAX_CONCURRENCY")
            ? ladybugDefaults.serverMaxConcurrency
            : Number(customLadybugEnv.LADYBUG_SERVER_MAX_CONCURRENCY),
        );
        expect(config.serverMaxQueue).toBe(
          missingKeys.includes("LADYBUG_SERVER_MAX_QUEUE")
            ? ladybugDefaults.serverMaxQueue
            : Number(customLadybugEnv.LADYBUG_SERVER_MAX_QUEUE),
        );
        expect(config.serverAutostart).toBe(
          missingKeys.includes("LADYBUG_SERVER_AUTOSTART")
            ? ladybugDefaults.serverAutostart
            : true,
        );
        expect(config.serverStartupTimeoutMs).toBe(
          missingKeys.includes("LADYBUG_SERVER_STARTUP_TIMEOUT_MS")
            ? ladybugDefaults.serverStartupTimeoutMs
            : Number(customLadybugEnv.LADYBUG_SERVER_STARTUP_TIMEOUT_MS),
        );
        expect(config.serverIdleTtlMs).toBe(
          missingKeys.includes("LADYBUG_SERVER_IDLE_TTL_MS")
            ? ladybugDefaults.serverIdleTtlMs
            : Number(customLadybugEnv.LADYBUG_SERVER_IDLE_TTL_MS),
        );
      }),
      { numRuns: 50 },
    );
  });

  it("Property 14: derived default paths contain TYPOCOP_PREFIX", async () => {
    await fc.assert(
      fc.asyncProperty(validPrefixArb, async (prefix) => {
        process.env = {
          ...originalEnv,
          TYPOCOP_PREFIX: prefix,
        };
        delete process.env["LADYBUGDB_PATH"];
        delete process.env["LADYBUG_SERVER_LOCK_PATH"];
        delete process.env["LADYBUG_SERVER_DISCOVERY_PATH"];

        const manager = new ConfigurationManager();
        await manager.initialize();
        const config = manager.getConfiguration().ladybugdb;

        expect(config.dbPath).toContain(`/${prefix}/`);
        expect(config.serverLockPath).toContain(`${prefix}-ladybug-server.lock`);
        expect(config.serverDiscoveryPath).toContain(`/${prefix}/`);
      }),
      { numRuns: 40 },
    );
  });
});
