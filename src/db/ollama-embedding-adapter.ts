/**
 * Ollama embedding adapter — generates embeddings via local Ollama HTTP API.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.6
 */

import type { OllamaConfig } from "../config/types.js";
import type { Embedding } from "../types/index.js";
import { verifyEmbeddingText } from "../security/privacy.js";
import type { EmbeddingAdapter } from "./types.js";

/** Response shape from Ollama's /api/embeddings endpoint. */
interface OllamaEmbeddingResponse {
  readonly embedding: number[];
  readonly model: string;
}

/**
 * Generates embeddings by calling a local Ollama instance.
 *
 * - Calls `POST {url}/api/embeddings` with the configured model (Req 4.1)
 * - Validates response dimensions match config (Req 4.2)
 * - Returns `null` when Ollama is unreachable — never throws (Req 4.3)
 * - All text passes `verifyEmbeddingText()` privacy check (Req 4.6)
 */
export class OllamaEmbeddingAdapter implements EmbeddingAdapter {
  private readonly config: OllamaConfig;

  constructor(config: OllamaConfig) {
    this.config = config;
  }

  isEnabled(): boolean {
    return true;
  }

  getDimensions(): number {
    return this.config.dimensions;
  }

  async embedText(text: string): Promise<Embedding | null> {
    // Req 4.6 — privacy check before sending to Ollama
    verifyEmbeddingText(text, "ollama-embedding");

    try {
      const response = await fetch(`${this.config.url}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.config.model, prompt: text }),
      });

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as OllamaEmbeddingResponse;

      // Req 4.2 — validate dimensions match config
      if (data.embedding.length !== this.config.dimensions) {
        return null;
      }

      return {
        vector: data.embedding,
        dimensions: data.embedding.length,
      };
    } catch {
      // Req 4.3 — return null when Ollama is unreachable
      return null;
    }
  }
}
