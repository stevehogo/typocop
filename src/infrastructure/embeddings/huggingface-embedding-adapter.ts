/**
 * HuggingFace embedding adapter — generates embeddings in-process via ONNX Runtime.
 *
 * Uses `@huggingface/transformers` with the configured model (default:
 * `mixedbread-ai/mxbai-embed-large-v1`). Unlike the Ollama adapter, no
 * external server is required — the model runs entirely in the Node.js process.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 7.1, 7.2
 */

import {
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";
import type { HuggingFaceConfig } from "../../platform/config/types.js";
import type { Embedding } from "../../core/domain.js";
import { verifyEmbeddingText } from "../../platform/security/privacy.js";
import type { EmbeddingAdapter } from "../../core/ports/persistence.js";

/**
 * Generates embeddings in-process using `@huggingface/transformers`.
 *
 * - Pipeline is lazily initialized on first `embedText()` call (Req 2.1, 2.2)
 * - Concurrent callers share a single init promise (Req 2.3)
 * - Failed init resets the promise so the next call retries (Req 2.4)
 * - Calls `verifyEmbeddingText()` before every inference (Req 3.1)
 * - Privacy exceptions propagate — all other errors return `null` (Req 1.5, 1.6, 3.2)
 * - Validates output dimensions match config (Req 1.4)
 * - `dispose()` releases the pipeline and ONNX session (Req 7.1, 7.2)
 */
export class HuggingFaceEmbeddingAdapter implements EmbeddingAdapter {
  private readonly config: HuggingFaceConfig;
  private extractor: FeatureExtractionPipeline | null = null;
  private initPromise: Promise<FeatureExtractionPipeline> | null = null;

  constructor(config: HuggingFaceConfig) {
    this.config = config;
  }

  /** Req 1.2 — always enabled when instantiated. */
  isEnabled(): boolean {
    return true;
  }

  /** Req 1.3 — returns the configured dimensions value. */
  getDimensions(): number {
    return this.config.dimensions;
  }

  /**
   * Generate an embedding for the given text.
   *
   * 1. Privacy check via `verifyEmbeddingText()` — throws on violation (Req 3.1, 3.2)
   * 2. Lazy-init the pipeline (Req 2.1, 2.2)
   * 3. Run inference with configured pooling
   * 4. Validate dimensions match config (Req 1.4, 1.5)
   * 5. Return `null` on any non-privacy error (Req 1.6)
   */
  async embedText(text: string): Promise<Embedding | null> {
    // Req 3.1 — privacy check before any inference
    verifyEmbeddingText(text, "huggingface-embedding");

    try {
      const ext = await this.ensurePipeline();

      const output = await ext(text, { pooling: this.config.pooling });
      const vectors: number[][] = output.tolist() as number[][];
      const vector: number[] = vectors[0];

      // Req 1.4, 1.5 — validate dimensions
      if (vector.length !== this.config.dimensions) {
        return null;
      }

      return { vector, dimensions: vector.length };
    } catch {
      // Req 1.6 — return null on any non-privacy error
      return null;
    }
  }

  /**
   * Release the pipeline and ONNX session resources.
   *
   * Safe to call even if the pipeline was never initialized (Req 7.2).
   * After disposal the adapter can be re-initialized by calling `embedText()` again.
   */
  async dispose(): Promise<void> {
    const ext = this.extractor;
    this.extractor = null;
    this.initPromise = null;

    if (ext) {
      await ext.dispose();
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Lazily initialize the feature-extraction pipeline.
   *
   * - First call creates the pipeline; subsequent calls return the cached instance (Req 2.2)
   * - Concurrent calls share the same promise (Req 2.3)
   * - On failure the promise is reset so the next call retries (Req 2.4)
   */
  private async ensurePipeline(): Promise<FeatureExtractionPipeline> {
    if (this.extractor) {
      return this.extractor;
    }

    if (!this.initPromise) {
      this.initPromise = pipeline(
        "feature-extraction",
        this.config.model,
        { dtype: this.config.dtype },
      )
        .then((p) => {
          this.extractor = p as FeatureExtractionPipeline;
          return this.extractor;
        })
        .catch((err: unknown) => {
          // Req 2.4 — allow retry on next call
          this.initPromise = null;
          throw err;
        });
    }

    return this.initPromise;
  }
}
