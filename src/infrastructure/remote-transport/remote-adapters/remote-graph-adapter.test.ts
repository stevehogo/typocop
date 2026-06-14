import { describe, expect, it, vi } from "vitest";

import { RemoteGraphAdapter } from "./remote-graph-adapter.js";
import type {
  GraphRpcMethod,
  RemoteRpcClient,
  RpcRequestMetadata,
} from "../remote-rpc-client.js";

function makeRpc(overrides: {
  readonly callGraph?: (
    method: GraphRpcMethod,
    request: { readonly metadata: RpcRequestMetadata; [key: string]: unknown },
  ) => Promise<unknown>;
} = {}): {
  readonly rpc: RemoteRpcClient;
  readonly callGraph: ReturnType<typeof vi.fn>;
} {
  const metadata: RpcRequestMetadata = {
    requestId: "req-1",
    timeoutMs: 1234,
    prefix: "tpc_",
  };
  const callGraph = vi.fn(overrides.callGraph || (async () => ({})));

  const rpc: RemoteRpcClient = {
    buildRequestMetadata: () => metadata,
    callGraph: callGraph as unknown as RemoteRpcClient["callGraph"],
    callVector: vi.fn() as unknown as RemoteRpcClient["callVector"],
  };

  return { rpc, callGraph };
}

describe("RemoteGraphAdapter", () => {
  it("serializes createNode payloads", async () => {
    const { rpc, callGraph } = makeRpc();
    const adapter = new RemoteGraphAdapter(rpc);

    await adapter.createNode("Symbol", { id: "s1", kind: "function" });

    expect(callGraph).toHaveBeenCalledWith(
      "CreateNode",
      expect.objectContaining({
        label: "Symbol",
        propertiesJson: JSON.stringify({ id: "s1", kind: "function" }),
      }),
    );
  });

  it("serializes createNodes batch payloads", async () => {
    const { rpc, callGraph } = makeRpc();
    const adapter = new RemoteGraphAdapter(rpc);

    const nodes = [
      { id: "s1", kind: "function" },
      { id: "s2", kind: "class" },
    ];
    await adapter.createNodes("Symbol", nodes);

    expect(callGraph).toHaveBeenCalledWith(
      "CreateNodes",
      expect.objectContaining({
        label: "Symbol",
        nodesJson: JSON.stringify(nodes),
      }),
    );
    const [, request] = callGraph.mock.calls[0];
    expect(JSON.parse(request.nodesJson)).toEqual(nodes);
  });

  it("serializes createRelationships batch payloads", async () => {
    const { rpc, callGraph } = makeRpc();
    const adapter = new RemoteGraphAdapter(rpc);

    const relationships = [
      { fromId: "a", toId: "b", properties: { step_order: 1 } },
      { fromId: "c", toId: "d" },
    ];
    await adapter.createRelationships("HAS_STEP", relationships);

    expect(callGraph).toHaveBeenCalledWith(
      "CreateRelationships",
      expect.objectContaining({
        type: "HAS_STEP",
        relationshipsJson: JSON.stringify(relationships),
      }),
    );
    const [, request] = callGraph.mock.calls[0];
    expect(JSON.parse(request.relationshipsJson)).toEqual(relationships);
  });

  it("deserializes QueryNodes responses", async () => {
    const { rpc } = makeRpc({
      callGraph: async () => ({
        nodes: [
          {
            id: "s1",
            labels: ["tpc_Symbol"],
            propertiesJson: JSON.stringify({ name: "main" }),
          },
        ],
      }),
    });
    const adapter = new RemoteGraphAdapter(rpc);

    const nodes = await adapter.queryNodes("Symbol");

    expect(nodes).toEqual([
      {
        id: "s1",
        labels: ["tpc_Symbol"],
        properties: { name: "main" },
      },
    ]);
  });

  it("deserializes QueryRelationships responses", async () => {
    const { rpc } = makeRpc({
      callGraph: async () => ({
        relationships: [
          {
            type: "tpc_CALLS",
            propertiesJson: JSON.stringify({ weight: 1 }),
            sourceId: "a",
            targetId: "b",
          },
        ],
      }),
    });
    const adapter = new RemoteGraphAdapter(rpc);

    const relationships = await adapter.queryRelationships("CALLS");

    expect(relationships).toEqual([
      {
        type: "tpc_CALLS",
        properties: { weight: 1 },
        sourceId: "a",
        targetId: "b",
      },
    ]);
  });

  it("deserializes RunCypher rows_json payloads", async () => {
    const { rpc } = makeRpc({
      callGraph: async () => ({
        rowsJson: [JSON.stringify({ n: { id: "node-1" } })],
      }),
    });
    const adapter = new RemoteGraphAdapter(rpc);

    const rows = await adapter.runCypher<{ readonly n: { readonly id: string } }>(
      "MATCH (n) RETURN n",
    );

    expect(rows).toEqual([{ n: { id: "node-1" } }]);
  });
});
