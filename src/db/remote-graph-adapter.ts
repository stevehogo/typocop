import type { GraphAdapter, GraphNode, GraphRelationship } from "./types.js";
import type { RemoteRpcClient, RpcRequestMetadata } from "./remote-rpc-client.js";

interface QueryNodesRequest {
  readonly metadata: RpcRequestMetadata;
  readonly label: string;
  readonly filterJson: string;
}

interface QueryNodesResponse {
  readonly nodes?: Array<{
    readonly id?: string;
    readonly labels?: readonly string[];
    readonly propertiesJson?: string;
  }>;
}

interface QueryRelationshipsRequest {
  readonly metadata: RpcRequestMetadata;
  readonly type: string;
}

interface QueryRelationshipsResponse {
  readonly relationships?: Array<{
    readonly type?: string;
    readonly propertiesJson?: string;
    readonly sourceId?: string;
    readonly targetId?: string;
  }>;
}

interface RunCypherResponse {
  readonly rowsJson?: readonly string[];
}

interface DeleteCountResponse {
  readonly deletedCount?: number;
}

export class RemoteGraphAdapter implements GraphAdapter {
  constructor(private readonly rpc: RemoteRpcClient) {}

  async createNode(
    label: string,
    properties: Record<string, unknown>,
  ): Promise<void> {
    await this.rpc.callGraph("CreateNode", {
      metadata: this.rpc.buildRequestMetadata(),
      label,
      propertiesJson: JSON.stringify(properties),
    });
  }

  async createRelationship(
    fromId: string,
    toId: string,
    type: string,
    properties: Record<string, unknown> = {},
  ): Promise<void> {
    await this.rpc.callGraph("CreateRelationship", {
      metadata: this.rpc.buildRequestMetadata(),
      fromId,
      toId,
      type,
      propertiesJson: JSON.stringify(properties),
    });
  }

  async queryNodes(
    label: string,
    filter: Record<string, unknown> = {},
  ): Promise<GraphNode[]> {
    const response = await this.rpc.callGraph<QueryNodesRequest, QueryNodesResponse>(
      "QueryNodes",
      {
        metadata: this.rpc.buildRequestMetadata(),
        label,
        filterJson: JSON.stringify(filter),
      },
    );

    return (response.nodes || []).map((node) => ({
      id: node.id || "",
      labels: [...(node.labels || [])],
      properties: parseJsonRecord(node.propertiesJson, "QueryNodes.propertiesJson"),
    }));
  }

  async queryRelationships(type: string): Promise<GraphRelationship[]> {
    const response = await this.rpc.callGraph<QueryRelationshipsRequest, QueryRelationshipsResponse>(
      "QueryRelationships",
      {
        metadata: this.rpc.buildRequestMetadata(),
        type,
      },
    );

    return (response.relationships || []).map((relationship) => ({
      type: relationship.type || "",
      properties: parseJsonRecord(
        relationship.propertiesJson,
        "QueryRelationships.propertiesJson",
      ),
      sourceId: relationship.sourceId || undefined,
      targetId: relationship.targetId || undefined,
    }));
  }

  async deleteNodesByLabel(label: string): Promise<number> {
    const response = await this.rpc.callGraph<
      { readonly metadata: RpcRequestMetadata; readonly label: string },
      DeleteCountResponse
    >("DeleteNodesByLabel", {
      metadata: this.rpc.buildRequestMetadata(),
      label,
    });
    return Number(response.deletedCount || 0);
  }

  async deleteRelationshipsByType(type: string): Promise<number> {
    const response = await this.rpc.callGraph<
      { readonly metadata: RpcRequestMetadata; readonly type: string },
      DeleteCountResponse
    >("DeleteRelationshipsByType", {
      metadata: this.rpc.buildRequestMetadata(),
      type,
    });
    return Number(response.deletedCount || 0);
  }

  async runCypher<T>(
    query: string,
    params: Record<string, unknown> = {},
  ): Promise<T[]> {
    const response = await this.rpc.callGraph<
      {
        readonly metadata: RpcRequestMetadata;
        readonly query: string;
        readonly paramsJson: string;
      },
      RunCypherResponse
    >("RunCypher", {
      metadata: this.rpc.buildRequestMetadata(),
      query,
      paramsJson: JSON.stringify(params),
    });

    return (response.rowsJson || []).map((row, index) =>
      parseJsonRecord(row, `RunCypher.rowsJson[${index}]`) as T
    );
  }

  async runCypherWrite(
    query: string,
    params: Record<string, unknown> = {},
  ): Promise<void> {
    await this.rpc.callGraph("RunCypherWrite", {
      metadata: this.rpc.buildRequestMetadata(),
      query,
      paramsJson: JSON.stringify(params),
    });
  }
}

function parseJsonRecord(
  value: string | undefined,
  context: string,
): Record<string, unknown> {
  if (!value) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${context} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${context} must decode to an object`);
  }
  return parsed as Record<string, unknown>;
}
