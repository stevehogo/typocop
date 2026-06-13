import type { SearchResult, Embedding } from "../../../core/domain.js";
import type { VectorAdapter } from "../../../core/ports/persistence.js";
import type { RemoteRpcClient, RpcRequestMetadata } from "../remote-rpc-client.js";

interface MutationResponse {
  readonly success?: boolean;
}

interface DeleteCountResponse {
  readonly deletedCount?: number;
}

interface SemanticSearchResponse {
  readonly results?: Array<{
    readonly symbolId?: string;
    readonly score?: number;
    readonly metadataJson?: string;
  }>;
}

export class RemoteVectorAdapter implements VectorAdapter {
  constructor(private readonly rpc: RemoteRpcClient) {}

  async createTables(): Promise<void> {
    await this.rpc.callVector<
      { readonly metadata: RpcRequestMetadata },
      MutationResponse
    >("CreateTables", {
      metadata: this.rpc.buildRequestMetadata(),
    });
  }

  async indexSymbol(
    symbolId: string,
    embedding: Embedding,
    metadata: Record<string, string> = {},
  ): Promise<void> {
    await this.rpc.callVector<
      {
        readonly metadata: RpcRequestMetadata;
        readonly symbolId: string;
        readonly embedding: Embedding;
        readonly metadataJson: string;
      },
      MutationResponse
    >("IndexSymbol", {
      metadata: this.rpc.buildRequestMetadata(),
      symbolId,
      embedding,
      metadataJson: JSON.stringify(metadata),
    });
  }

  async semanticSearch(
    queryEmbedding: Embedding,
    limit: number,
  ): Promise<SearchResult[]> {
    const response = await this.rpc.callVector<
      {
        readonly metadata: RpcRequestMetadata;
        readonly embedding: Embedding;
        readonly limit: number;
      },
      SemanticSearchResponse
    >("SemanticSearch", {
      metadata: this.rpc.buildRequestMetadata(),
      embedding: queryEmbedding,
      limit,
    });

    return (response.results || []).map((result, index) => ({
      symbolId: result.symbolId || "",
      score: Number(result.score || 0),
      metadata: parseStringRecord(
        result.metadataJson,
        `SemanticSearch.results[${index}].metadataJson`,
      ),
    }));
  }

  async deleteAll(): Promise<number> {
    const response = await this.rpc.callVector<
      { readonly metadata: RpcRequestMetadata },
      DeleteCountResponse
    >("DeleteAll", {
      metadata: this.rpc.buildRequestMetadata(),
    });
    return Number(response.deletedCount || 0);
  }
}

function parseStringRecord(
  value: string | undefined,
  context: string,
): Record<string, string> {
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
  const entries = Object.entries(parsed as Record<string, unknown>);
  for (const [key, entryValue] of entries) {
    if (typeof entryValue !== "string") {
      throw new Error(`${context}.${key} must be a string`);
    }
  }
  return Object.fromEntries(entries) as Record<string, string>;
}
