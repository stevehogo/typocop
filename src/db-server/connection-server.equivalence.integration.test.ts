import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@grpc/proto-loader", async () => {
  const { createProtoLoaderMock } = await import("./grpc-test-mocks.js");
  return createProtoLoaderMock();
});

vi.mock("@grpc/grpc-js", async () => {
  const { createGrpcJsMock } = await import("./grpc-test-mocks.js");
  return createGrpcJsMock();
});

import { createDatabaseAdapter } from "../db/database-adapter.js";
import { RemoteDatabaseAdapter } from "../db/remote-database-adapter.js";
import { startConnectionServer } from "./server.js";
import {
  applyWorkload,
  makeClientConfig,
  makeFullConfig,
  makeServerConfig,
  sortNodes,
  sortRelationships,
} from "./connection-server.test-support.js";

describe("Ladybug connection server adapter equivalence — integration test", () => {
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

  it("14.5 local and remote adapters produce equivalent results for the same operations", async () => {
    const root = await mkdtemp(join(tmpdir(), "typocop-ladybug-equivalence-"));
    const remoteServerConfig = makeServerConfig(join(root, "remote"), { port: 7622 });
    const server = await startConnectionServer(remoteServerConfig);
    const remoteAdapter = new RemoteDatabaseAdapter(makeClientConfig(remoteServerConfig));
    const noopEmbedding = { isEnabled: () => false, embedText: async () => null, getDimensions: () => 0 };
    const localAdapter = await createDatabaseAdapter(makeFullConfig(join(root, "local", "db.ladybug")), noopEmbedding);

    try {
      await remoteAdapter.initialize();

      await applyWorkload(localAdapter);
      await applyWorkload(remoteAdapter);

      const localGraph = localAdapter.getGraphAdapter();
      const remoteGraph = remoteAdapter.getGraphAdapter();
      const localVector = localAdapter.getVectorAdapter();
      const remoteVector = remoteAdapter.getVectorAdapter();

      const [localNodes, remoteNodes] = await Promise.all([
        localGraph.queryNodes("Symbol"),
        remoteGraph.queryNodes("Symbol"),
      ]);
      const [localRelationships, remoteRelationships] = await Promise.all([
        localGraph.queryRelationships("CALLS"),
        remoteGraph.queryRelationships("CALLS"),
      ]);
      const [localRows, remoteRows] = await Promise.all([
        localGraph.runCypher<{ readonly n: { readonly labels: readonly string[]; readonly properties: Record<string, unknown> } }>(
          "MATCH (n:Symbol) RETURN n ORDER BY n.id",
        ),
        remoteGraph.runCypher<{ readonly n: { readonly labels: readonly string[]; readonly properties: Record<string, unknown> } }>(
          "MATCH (n:Symbol) RETURN n ORDER BY n.id",
        ),
      ]);
      const [localDeleted, remoteDeleted] = await Promise.all([
        localVector.deleteAll(),
        remoteVector.deleteAll(),
      ]);

      expect(sortNodes(localNodes)).toEqual(sortNodes(remoteNodes));
      expect(sortRelationships(localRelationships)).toEqual(sortRelationships(remoteRelationships));
      expect(localRows).toEqual(remoteRows);
      expect(localDeleted).toBe(2);
      expect(remoteDeleted).toBe(2);
    } finally {
      await localAdapter.close();
      await remoteAdapter.close();
      await server.shutdown("test");
      await rm(root, { recursive: true, force: true });
    }
  });
});
