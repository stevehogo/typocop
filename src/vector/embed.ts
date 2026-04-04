/**
 * Generate embedding for a text query.
 * Requirements: 8.1, 8.2, 8.3
 */
import type { Embedding } from "../types/index.js";
import { embedText, type EmbeddingConfig } from "../indexer/search/embed.js";

/**
 * Generate embedding for a query string.
 * Uses OpenAI text-embedding-3-large (3072 dimensions).
 */
export async function generateEmbedding(query: string): Promise<Embedding> {
  const config: EmbeddingConfig = {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: "text-embedding-3-large",
    dimensions: 3072,
  };

  const embedding = await embedText(query, config);
  
  if (!embedding) {
    throw new Error("Failed to generate embedding: service unavailable");
  }

  return embedding;
}
