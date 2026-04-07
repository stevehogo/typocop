// Phase 6: Embedding generation for symbols and clusters
// Calls OpenAI text-embedding-3-large with 1536 dimensions (reduced from 3072
// to stay within pgvector's 2000-dimension index limit while preserving quality).
// Requirements: 22.1, 22.2 - Only symbol signatures are sent, never full code

import OpenAI from "openai";
import type { Symbol, Cluster, Embedding } from "../../types/index.js";
import { verifyEmbeddingText } from "../../security/privacy.js";

export interface EmbeddingConfig {
  readonly apiKey: string;
  readonly model: string;       // "text-embedding-3-large"
  readonly dimensions: number;  // 1536
}

const EMBEDDING_DIMENSIONS = 1536;

/**
 * Formats a symbol into a text string suitable for embedding.
 * Includes name, kind, signature, documentation, file context, and semantic tags.
 * 
 * PRIVACY: Only symbol metadata is included, never full source code.
 * Requirements: 22.2
 */
export function formatSymbolForEmbedding(symbol: Symbol): string {
  const parts: string[] = [
    `${symbol.kind}: ${symbol.name}`,
  ];
  
  // Add file and module context
  if (symbol.location?.filePath) {
    const filePath = symbol.location.filePath;
    parts.push(`file: ${filePath}`);
    
    // Extract module/folder context from path
    const pathParts = filePath.split('/');
    if (pathParts.length > 1) {
      const module = pathParts.slice(0, -1).join('/');
      parts.push(`module: ${module}`);
    }
  }
  
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
  
  const formatted = parts.join("\n");
  
  // Verify no source code is included (Req 22.2)
  verifyEmbeddingText(formatted, `symbol ${symbol.name}`);
  
  return formatted;
}

/**
 * Formats a cluster and its resolved symbols into a text string for embedding.
 * Includes cluster metadata, symbol details, and semantic relationships.
 * 
 * PRIVACY: Only cluster metadata and symbol names/kinds are included.
 * Requirements: 22.2
 */
export function formatClusterForEmbedding(cluster: Cluster, symbols: Symbol[]): string {
  const parts: string[] = [
    `cluster: ${cluster.name}`,
    `category: ${cluster.category}`,
    `confidence: ${cluster.confidence.toFixed(2)}`,
  ];
  
  if (symbols.length > 0) {
    // Include detailed symbol information
    const symbolDetails = symbols
      .map(s => {
        const details = [`${s.kind} ${s.name}`];
        if (s.location?.filePath) {
          const module = s.location.filePath.split('/').slice(0, -1).join('/');
          details.push(`(${module})`);
        }
        return details.join(' ');
      })
      .join(", ");
    parts.push(`symbols: ${symbolDetails}`);
    
    // Extract semantic tags from symbol names and kinds
    const semanticTags = new Set<string>();
    symbols.forEach(s => {
      // Extract keywords from symbol names
      const nameWords = s.name.toLowerCase().split(/[_-]/);
      nameWords.forEach(word => {
        if (word.length > 3) semanticTags.add(word);
      });
      
      // Add kind as semantic tag
      semanticTags.add(s.kind);
    });
    
    if (semanticTags.size > 0) {
      parts.push(`tags: ${Array.from(semanticTags).join(", ")}`);
    }
  }
  
  const formatted = parts.join("\n");
  
  // Verify no source code is included (Req 22.2)
  verifyEmbeddingText(formatted, `cluster ${cluster.name}`);
  
  return formatted;
}

/**
 * Calls the OpenAI embedding API and returns a 1536-dimension Embedding.
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
