import { randomUUID } from "node:crypto";

import * as grpc from "@grpc/grpc-js";

import type { LadybugClientConfig } from "../../../platform/config/types.js";
import { RemoteGraphAdapter } from "./remote-graph-adapter.js";
import {
  closeClients,
  createRpcClients,
  isTransientGrpcError,
  toGrpcTarget,
  waitForReadyWithRetry,
} from "../remote-grpc.js";
import {
  DEFAULT_RPC_TIMEOUT_MS,
  type GraphRpcMethod,
  type RemoteRpcClient,
  type RpcClientBundle,
  type RpcRequestMetadata,
  type UnaryRpcMethod,
  type VectorRpcMethod,
} from "../remote-rpc-client.js";
import { RemoteVectorAdapter } from "./remote-vector-adapter.js";
import type {
  DatabaseAdapter,
  EmbeddingAdapter,
  GraphAdapter,
  VectorAdapter,
} from "../../../core/ports/persistence.js";

interface RemoteDatabaseAdapterOptions {
  readonly createClients?: (target: string, maxMessageBytes: number) => RpcClientBundle;
  readonly defaultTimeoutMs?: number;
  /**
   * Injected embedding adapter (§14). Selected at the composition root via
   * `createEmbeddingAdapter`; remote-transport never builds embeddings itself.
   */
  readonly embeddingAdapter?: EmbeddingAdapter;
}

export class RemoteDatabaseAdapter implements DatabaseAdapter, RemoteRpcClient {
  private readonly createClients: (target: string, maxMessageBytes: number) => RpcClientBundle;
  private readonly defaultTimeoutMs: number;
  private clients: RpcClientBundle | null = null;
  private graphAdapter: GraphAdapter | null = null;
  private vectorAdapter: VectorAdapter | null = null;
  private embeddingAdapter: EmbeddingAdapter | null = null;
  private reconnecting: Promise<void> | null = null;

  constructor(
    private readonly config: LadybugClientConfig,
    private readonly options: RemoteDatabaseAdapterOptions = {},
  ) {
    this.createClients = options.createClients || createRpcClients;
    this.defaultTimeoutMs = options.defaultTimeoutMs || DEFAULT_RPC_TIMEOUT_MS;
  }

  async initialize(): Promise<void> {
    if (this.clients) {
      return;
    }

    const clients = this.createClients(
      toGrpcTarget(this.config.serverUrl),
      this.config.grpcMaxMessageBytes,
    );
    await Promise.all([
      waitForReadyWithRetry(clients.graph),
      waitForReadyWithRetry(clients.vector),
    ]);

    this.clients = clients;
    this.graphAdapter = new RemoteGraphAdapter(this);
    this.vectorAdapter = new RemoteVectorAdapter(this);
    this.embeddingAdapter = this.options.embeddingAdapter ?? null;
  }

  async close(): Promise<void> {
    if (!this.clients) {
      return;
    }

    closeClients(this.clients);
    this.clients = null;
    this.graphAdapter = null;
    this.vectorAdapter = null;
    this.embeddingAdapter = null;
  }

  getGraphAdapter(): GraphAdapter {
    if (!this.graphAdapter) {
      throw new Error("DatabaseAdapter not initialized — call initialize() first");
    }
    return this.graphAdapter;
  }

  getVectorAdapter(): VectorAdapter {
    if (!this.vectorAdapter) {
      throw new Error("DatabaseAdapter not initialized — call initialize() first");
    }
    return this.vectorAdapter;
  }

  getEmbeddingAdapter(): EmbeddingAdapter {
    if (!this.embeddingAdapter) {
      throw new Error("DatabaseAdapter not initialized — call initialize() first");
    }
    return this.embeddingAdapter;
  }

  buildRequestMetadata(timeoutMs = this.defaultTimeoutMs): RpcRequestMetadata {
    return {
      requestId: randomUUID(),
      timeoutMs,
      prefix: this.config.prefix,
    };
  }

  callGraph<Req extends { readonly metadata: RpcRequestMetadata }, Res>(
    method: GraphRpcMethod,
    request: Req,
  ): Promise<Res> {
    return this.callWithReconnect(
      () => this.invokeRpc(this.requireClients().graph, method, request),
    );
  }

  callVector<Req extends { readonly metadata: RpcRequestMetadata }, Res>(
    method: VectorRpcMethod,
    request: Req,
  ): Promise<Res> {
    return this.callWithReconnect(
      () => this.invokeRpc(this.requireClients().vector, method, request),
    );
  }

  private requireClients(): RpcClientBundle {
    if (!this.clients) {
      throw new Error("DatabaseAdapter not initialized — call initialize() first");
    }
    return this.clients;
  }

  private async callWithReconnect<T>(execute: () => Promise<T>): Promise<T> {
    try {
      return await execute();
    } catch (error) {
      if (!isTransientGrpcError(error)) {
        throw error;
      }
      await this.reconnect();
      return execute();
    }
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) {
      return this.reconnecting;
    }

    this.reconnecting = (async () => {
      const previous = this.requireClients();
      const next = this.createClients(
        toGrpcTarget(this.config.serverUrl),
        this.config.grpcMaxMessageBytes,
      );
      try {
        await Promise.all([
          waitForReadyWithRetry(next.graph),
          waitForReadyWithRetry(next.vector),
        ]);
      } catch (error) {
        closeClients(next);
        throw error;
      }

      this.clients = next;
      closeClients(previous);
    })();

    try {
      await this.reconnecting;
    } finally {
      this.reconnecting = null;
    }
  }

  private invokeRpc<Req extends { readonly metadata: RpcRequestMetadata }, Res>(
    client: { [method: string]: unknown },
    method: string,
    request: Req,
  ): Promise<Res> {
    const callMetadata = new grpc.Metadata();
    callMetadata.set("x-timeout-ms", String(request.metadata.timeoutMs));
    if (this.config.authToken !== "") {
      callMetadata.set("authorization", `Bearer ${this.config.authToken}`);
    }

    return new Promise<Res>((resolve, reject) => {
      const candidate = client[method];
      if (typeof candidate !== "function") {
        reject(new Error(`RPC method ${method} is unavailable`));
        return;
      }

      const rpcMethod = candidate as UnaryRpcMethod<Req, Res>;
      rpcMethod.call(
        client,
        request,
        callMetadata,
        { deadline: new Date(Date.now() + request.metadata.timeoutMs) },
        (error, response) => {
          if (error) {
            reject(error);
            return;
          }
          if (response === undefined) {
            reject(new Error(`RPC ${method} returned an empty response`));
            return;
          }
          resolve(response);
        },
      );
    });
  }

}
