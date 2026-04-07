/**
 * Generate embedding for a text query.
 * Requirements: 8.1, 8.2, 8.3, 22.3
 */
import type { Embedding } from "../types/index.js";
import { embedText, type EmbeddingConfig } from "../indexer/search/embed.js";
import { preprocessQuery } from "../query/preprocess.js";

/**
 * Generate embedding for a query string.
 * Uses OpenAI text-embedding-3-large with 1536 dimensions.
 * 
 * Preprocesses the query for consistency (lowercase, remove punctuation, normalize whitespace).
 * 
 * Requirements: 8.1, 8.2, 8.3, 22.3
 */
export async function generateEmbedding(query: string): Promise<Embedding> {
  const config: EmbeddingConfig = {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: "text-embedding-3-large",
    dimensions: 1536,
  };

  // Preprocess query for consistency (Req 22.3)
  const preprocessedQuery = preprocessQuery(query);

  const embedding = await embedText(preprocessedQuery, config);
  
  if (!embedding) {
    throw new Error("Failed to generate embedding: service unavailable");
  }

  return embedding;
}
