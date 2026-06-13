/**
 * Embedding-adapter factory — the provider-selection switch.
 *
 * Lives at the composition seam (called by apps / wiring code), NOT inside the
 * persistence or remote-transport adapters: those receive an `EmbeddingAdapter`
 * injected via the `core/ports` interface so they never statically import a
 * concrete embeddings sibling (TARGET-ARCHITECTURE §14, breaks the future
 * infrastructure→sibling-infrastructure edge). Moves to
 * infrastructure/embeddings/index.ts in PR6.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4
 */
import type { EmbeddingAdapter } from "../core/ports/persistence.js";
import type { EmbeddingConfig, FullConfig, OllamaConfig } from "../platform/config/types.js";
import { HuggingFaceEmbeddingAdapter } from "./huggingface-embedding-adapter.js";
import { OllamaEmbeddingAdapter } from "./ollama-embedding-adapter.js";
import { NoOpEmbeddingAdapter } from "./noop-embedding-adapter.js";

/**
 * Select the embedding adapter for a provider:
 * - `"huggingface"` → HuggingFaceEmbeddingAdapter (Req 6.1)
 * - `"ollama"`      → OllamaEmbeddingAdapter (Req 6.2)
 * - `"none"`        → NoOpEmbeddingAdapter (Req 6.3)
 */
export function createEmbeddingAdapter(
  embedding: EmbeddingConfig,
  ollama: OllamaConfig,
): EmbeddingAdapter {
  switch (embedding.provider) {
    case "huggingface":
      return new HuggingFaceEmbeddingAdapter(embedding.huggingface);
    case "ollama":
      return new OllamaEmbeddingAdapter(ollama);
    case "none":
      return new NoOpEmbeddingAdapter();
  }
}

/** Convenience over {@link createEmbeddingAdapter} for a resolved FullConfig. */
export function createEmbeddingAdapterFromConfig(config: FullConfig): EmbeddingAdapter {
  return createEmbeddingAdapter(config.embedding, config.ollama);
}
