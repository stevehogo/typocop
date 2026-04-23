/**
 * No-op embedding adapter — used when Ollama is disabled.
 *
 * Requirements: 4.4, 4.5
 */

import type { Embedding } from "../types/index.js";
import type { EmbeddingAdapter } from "./types.js";

/**
 * Embedding adapter that does nothing.
 *
 * - `isEnabled()` returns `false` (Req 4.4)
 * - `embedText()` always returns `null` (Req 4.4)
 * - `getDimensions()` returns `0` (Req 4.5)
 *
 * Used when `OLLAMA_ENABLED` is unset or `"false"` (Req 4.5).
 */
export class NoOpEmbeddingAdapter implements EmbeddingAdapter {
  isEnabled(): boolean {
    return false;
  }

  getDimensions(): number {
    return 0;
  }

  async embedText(_text: string): Promise<Embedding | null> {
    return null;
  }
}
