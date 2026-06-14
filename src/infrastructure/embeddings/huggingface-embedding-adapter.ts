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
 * Maximum characters accepted for a single batched embedding text. Texts longer
 * than this are excluded from the batch (marked null) up front, since an
 * over-long item risks rejecting the whole all-or-nothing forward pass.
 */
const MAX_EMBEDDING_TEXT_LENGTH = 100_000;

/**
 * PRE-INFERENCE per-item validation for the batch path. Runs the same privacy
 * gate as `embedText` (`verifyEmbeddingText`) plus basic length/encoding checks.
 *
 * Returns `true` if the text is safe to send into the batch, `false` otherwise.
 * Unlike the per-item `embedText` path (where a privacy violation THROWS), batch
 * validation cannot reject the whole batch for one bad item — so a failing item
 * is excluded (marked null) instead of throwing.
 */
function isValidEmbeddingInput(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  if (text.length > MAX_EMBEDDING_TEXT_LENGTH) return false;
  // Reject invalid UTF-16 (lone surrogates) that can break tokenization.
  if (hasLoneSurrogate(text)) return false;
  try {
    verifyEmbeddingText(text, "huggingface-embedding");
  } catch {
    return false;
  }
  return true;
}

/** True if `text` contains an unpaired UTF-16 surrogate (invalid encoding). */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // high surrogate — must be followed by a low surrogate
      const next = text.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      i++; // valid pair — skip the low surrogate
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // low surrogate without a preceding high surrogate
      return true;
    }
  }
  return false;
}

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
   * Batch fast-path — embed many texts in a SINGLE forward pass (Phase 1).
   *
   * Returns one result per input, index-aligned (`result[i]` ↔ `texts[i]`).
   *
   * Control flow:
   * 1. PRE-INFERENCE per-item validation (privacy via `verifyEmbeddingText` +
   *    basic length/encoding). A failing item is marked `null` at its index and
   *    is NOT sent into the batch — this is the only source of per-item `null`.
   * 2. The remaining valid texts are embedded in one `ext(texts, { pooling })`
   *    call; `output.tolist()` yields `number[][]` (one row per input), read
   *    ALL rows. A row whose length ≠ configured dimensions → `null` at that
   *    index.
   * 3. Because inference is ALL-OR-NOTHING (no per-item error channel in
   *    transformers.js), if `ext()` throws/rejects the WHOLE call rejects. We
   *    let it reject so the caller falls back to per-item `embedText`. We do NOT
   *    swallow inference errors into per-row nulls — that would silently lose
   *    per-item failure accounting.
   */
  async embedTexts(texts: string[]): Promise<(Embedding | null)[]> {
    const results: (Embedding | null)[] = new Array(texts.length).fill(null);

    // Step 1 — pre-inference validation. Collect the indices of valid texts so
    // we can scatter the batch output back to original positions.
    const validIndices: number[] = [];
    const validTexts: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      if (isValidEmbeddingInput(texts[i])) {
        validIndices.push(i);
        validTexts.push(texts[i]);
      }
      // else: leave results[i] === null (pre-inference validation failure)
    }

    if (validTexts.length === 0) {
      return results;
    }

    // Step 2/3 — single forward pass over all valid texts. Any throw here
    // (OOM / malformed tensor) rejects the whole call by design; the caller
    // falls back to per-item embedText.
    const ext = await this.ensurePipeline();
    const output = await ext(validTexts, { pooling: this.config.pooling });
    const rows: number[][] = output.tolist() as number[][];

    for (let k = 0; k < validIndices.length; k++) {
      const row = rows[k];
      if (Array.isArray(row) && row.length === this.config.dimensions) {
        results[validIndices[k]] = { vector: row, dimensions: row.length };
      }
      // else: bad/missing row → leave null at that index
    }

    return results;
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
