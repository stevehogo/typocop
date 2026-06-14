import type { Metadata } from "@grpc/grpc-js";

export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

export type GraphRpcMethod =
  | "QueryNodes"
  | "QueryRelationships"
  | "RunCypher"
  | "RunCypherWrite"
  | "CreateNode"
  | "CreateRelationship"
  | "CreateNodes"
  | "CreateRelationships"
  | "DeleteNodesByLabel"
  | "DeleteRelationshipsByType";

export type VectorRpcMethod =
  | "CreateTables"
  | "IndexSymbol"
  | "IndexSymbols"
  | "SemanticSearch"
  | "DeleteAll";

export interface RpcRequestMetadata {
  readonly requestId: string;
  readonly timeoutMs: number;
  readonly prefix: string;
}

export interface RpcServiceClient {
  waitForReady(deadline: Date, callback: (error?: Error | null) => void): void;
  close(): void;
  [method: string]: unknown;
}

export interface RpcClientBundle {
  readonly graph: RpcServiceClient;
  readonly vector: RpcServiceClient;
}

export interface RemoteRpcClient {
  buildRequestMetadata(timeoutMs?: number): RpcRequestMetadata;
  callGraph<Req extends { readonly metadata: RpcRequestMetadata }, Res>(
    method: GraphRpcMethod,
    request: Req,
  ): Promise<Res>;
  callVector<Req extends { readonly metadata: RpcRequestMetadata }, Res>(
    method: VectorRpcMethod,
    request: Req,
  ): Promise<Res>;
}

export type UnaryRpcMethod<Req, Res> = (
  request: Req,
  metadata: Metadata,
  options: { readonly deadline: Date },
  callback: (error: Error | null, response?: Res) => void,
) => void;
