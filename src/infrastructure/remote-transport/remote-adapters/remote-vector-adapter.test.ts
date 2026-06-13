import { describe, expect, it, vi } from "vitest";

import type { Embedding } from "../../../core/domain.js";
import { RemoteVectorAdapter } from "./remote-vector-adapter.js";
import type {
  RemoteRpcClient,
  RpcRequestMetadata,
  VectorRpcMethod,
} from "../remote-rpc-client.js";

function makeRpc(overrides: {
  readonly callVector?: (
    method: VectorRpcMethod,
    request: { readonly metadata: RpcRequestMetadata; [key: string]: unknown },
  ) => Promise<unknown>;
} = {}): {
  readonly rpc: RemoteRpcClient;
  readonly callVector: ReturnType<typeof vi.fn>;
} {
  const metadata: RpcRequestMetadata = {
    requestId: "req-1",
    timeoutMs: 1234,
    prefix: "tpc_",
  };
  const callVector = vi.fn(overrides.callVector || (async () => ({})));

  const rpc: RemoteRpcClient = {
    buildRequestMetadata: () => metadata,
    callGraph: vi.fn() as unknown as RemoteRpcClient["callGraph"],
    callVector: callVector as unknown as RemoteRpcClient["callVector"],
  };

  return { rpc, callVector };
}

describe("RemoteVectorAdapter", () => {
  const embedding: Embedding = { vector: [0.1, 0.2], dimensions: 2 };

  it("serializes IndexSymbol payloads", async () => {
    const { rpc, callVector } = makeRpc();
    const adapter = new RemoteVectorAdapter(rpc);

    await adapter.indexSymbol("sym-1", embedding, { kind: "function" });

    expect(callVector).toHaveBeenCalledWith(
      "IndexSymbol",
      expect.objectContaining({
        symbolId: "sym-1",
        embedding,
        metadataJson: JSON.stringify({ kind: "function" }),
      }),
    );
  });

  it("deserializes SemanticSearch responses", async () => {
    const { rpc } = makeRpc({
      callVector: async () => ({
        results: [
          {
            symbolId: "sym-1",
            score: 0.91,
            metadataJson: JSON.stringify({ kind: "class" }),
          },
        ],
      }),
    });
    const adapter = new RemoteVectorAdapter(rpc);

    const results = await adapter.semanticSearch(embedding, 5);

    expect(results).toEqual([
      {
        symbolId: "sym-1",
        score: 0.91,
        metadata: { kind: "class" },
      },
    ]);
  });

  it("deserializes DeleteAll responses", async () => {
    const { rpc } = makeRpc({
      callVector: async () => ({ deletedCount: 12 }),
    });
    const adapter = new RemoteVectorAdapter(rpc);

    const deleted = await adapter.deleteAll();

    expect(deleted).toBe(12);
  });
});
