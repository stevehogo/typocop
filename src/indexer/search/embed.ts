// Phase 6: Embedding generation for symbols and clusters
// Calls OpenAI text-embedding-3-large (3072 dimensions)

import OpenAI from "openai";
import type { Symbol, Cluster, Embedding } from "../../types/index.js";

export interface EmbeddingConfig {
  readonly apiKey: string;
  readonly model: string;       // "text-embedding-3-large"
  readonly dimensions: number;  // 3072
}

const EMBEDDING_DIMENSIONS = 3072;

/**
 * Formats a symbol into a text string suitable for embedding.
 * Uses name, kind, signature, and documentation.
 */
export function formatSymbolForEmbedding(symbol: Symbol): string {
  const parts: string[] = [
    `${symbol.kind}: ${symbol.name}`,
  ];
  if (symbol.signature) {
    parts.push(`signature: ${symbol.signature}`);
  }
  if (symbol.documentation) {
    parts.push(`docs: ${symbol.documentation}`);
  }
  parts.push(`visibility: ${symbol.visibility}`);
  if (symbol.modifiers.length > 0) {
    parts.push(`modifiers: ${symbol.modifiers.join(", ")}`);
  }
  return parts.join("\n");
}

/**
 * Formats a cluster and its resolved symbols into a text string for embedding.
 */
export function formatClusterForEmbedding(cluster: Cluster, symbols: Symbol[]): string {
  const parts: string[] = [
    `cluster: ${cluster.name}`,
    `category: ${cluster.category}`,
    `confidence: ${cluster.confidence.toFixed(2)}`,
  ];
  if (symbols.length > 0) {
    const symbolNames = symbols.map(s => `${s.kind} ${s.name}`).join(", ");
    parts.push(`symbols: ${symbolNames}`);
  }
  return parts.join("\n");
}

/**
 * Calls the OpenAI embedding API and returns a 3072-dimension Embedding.
 * Returns null if the embedding service is unavailable (caller handles fallback).
 */
export async function embedText(
  text: string,
  config: EmbeddingConfig,
): Promise<Embedding | null> {
  const client = new OpenAI({ apiKey: config.apiKey });
  try {
    const response = await client.embeddings.create({
      model: config.model,
      input: text,
      dimensions: config.dimensions,
    });
    const vector = response.data[0]?.embedding;
    if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
      console.warn(
        `[embed] Unexpected embedding dimensions: expected ${EMBEDDING_DIMENSIONS}, got ${vector?.length ?? 0}`,
      );
      return null;
    }
    return { vector, dimensions: EMBEDDING_DIMENSIONS };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[embed] Embedding service unavailable: ${message}`);
    return null;
  }
}
