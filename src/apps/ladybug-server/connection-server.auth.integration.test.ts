import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@grpc/proto-loader", async () => {
  const { createProtoLoaderMock } = await import("../../../tests/support/grpc-test-mocks.js");
  return createProtoLoaderMock();
});

vi.mock("@grpc/grpc-js", async () => {
  const { createGrpcJsMock } = await import("../../../tests/support/grpc-test-mocks.js");
  return createGrpcJsMock();
});

import { RemoteDatabaseAdapter } from "../../infrastructure/remote-transport/remote-adapters/remote-database-adapter.js";
import { startConnectionServer } from "./server.js";
import { makeClientConfig, makeServerConfig } from "../../../tests/support/connection-server.test-support.js";

describe("Ladybug connection server auth enforcement — integration test", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    const grpcModule = await import("@grpc/grpc-js") as unknown as {
      readonly __clearServers: () => void;
    };
    grpcModule.__clearServers();
  });

  it("14.6 auth token enforcement rejects unauthorized clients and allows authorized ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "typocop-ladybug-auth-"));
    const serverConfig = makeServerConfig(root, {
      port: 7623,
      authToken: "secret-token",
    });
    const server = await startConnectionServer(serverConfig);
    const unauthorized = new RemoteDatabaseAdapter(
      makeClientConfig(serverConfig, { authToken: "" }),
    );
    const authorized = new RemoteDatabaseAdapter(
      makeClientConfig(serverConfig, { authToken: "secret-token" }),
    );

    try {
      await Promise.all([unauthorized.initialize(), authorized.initialize()]);

      await expect(unauthorized.getGraphAdapter().queryNodes("Symbol")).rejects.toMatchObject({
        code: 16,
      });
      await expect(authorized.getGraphAdapter().queryNodes("Symbol")).resolves.toEqual([]);
    } finally {
      await Promise.all([unauthorized.close(), authorized.close()]);
      await server.shutdown("test");
      await rm(root, { recursive: true, force: true });
    }
  });
});
