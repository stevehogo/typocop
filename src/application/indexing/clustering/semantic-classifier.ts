/**
 * Semantic Cluster Classifier — uses Ollama embeddings to classify clusters.
 *
 * Computes cosine similarity between a cluster's aggregated text embedding
 * and predefined category reference embeddings, returning the best match
 * above a threshold (≥ 0.50) or "unknown".
 *
 * Requirements: 10.1, 10.2, 10.3, 10.5, 10.6
 */
import type { ClusterCategory, Embedding, Symbol } from "../../../core/domain.js";
import type { EmbeddingAdapter } from "../../../core/ports/persistence.js";
import { verifyEmbeddingText } from "../../../platform/security/privacy.js";
import { isEmbeddingBatchEnabled } from "../../../platform/utils/limits.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum cosine similarity to accept a category match. (Req 10.2) */
export const SEMANTIC_THRESHOLD = 0.50;

/** All valid non-unknown categories for classification. */
const CLASSIFIABLE_CATEGORIES: readonly ClusterCategory[] = [
  "authentication",
  "dataAccess",
  "businessLogic",
  "uiComponent",
  "utility",
] as const;

/** All valid ClusterCategory values (including "unknown"). */
export const ALL_CATEGORIES: readonly ClusterCategory[] = [
  ...CLASSIFIABLE_CATEGORIES,
  "unknown",
] as const;

// ─── Category Reference Texts (Req 10.5) ─────────────────────────────────────

/**
 * One descriptive paragraph per ClusterCategory describing what that
 * category represents. Used to generate reference embeddings.
 */
export const CATEGORY_REFERENCE_TEXTS: Readonly<Record<Exclude<ClusterCategory, "unknown">, string>> = {
  authentication:
    "Authentication and authorization module handling user login, logout, " +
    "session management, JWT token generation and validation, OAuth flows, " +
    "password hashing, credential verification, role-based access control, " +
    "permission guards, and security middleware for protecting routes.",

  dataAccess:
    "Data access layer including repositories, data access objects, ORM models, " +
    "database entities, schema definitions, migrations, query builders, " +
    "database connections, persistence logic, record collections, and " +
    "storage abstractions for reading and writing structured data.",

  businessLogic:
    "Business logic layer containing services, managers, handlers, processors, " +
    "calculators, validators, workflow engines, business rule evaluators, " +
    "policy enforcers, orchestrators, and domain-specific computation that " +
    "implements core application requirements and use cases.",

  uiComponent:
    "User interface components including views, templates, renderers, widgets, " +
    "pages, layouts, forms, modals, buttons, input fields, display elements, " +
    "and presentational logic for building interactive user experiences.",

  utility:
    "Utility and helper functions for formatting, parsing, converting, " +
    "transforming, sanitizing, encoding, decoding, hashing, cryptographic " +
    "operations, logging, configuration management, constants, enumerations, " +
    "and general-purpose reusable code.",
};

// ─── Cosine Similarity ───────────────────────────────────────────────────────

/** Compute cosine similarity: dot(a,b) / (|a| * |b|). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}


// ─── Cluster Text Aggregation (Req 10.6) ─────────────────────────────────────

/**
 * Build a privacy-safe text representation of a cluster's symbols.
 * Uses only symbol names, kinds, and signatures — never source code.
 */
export function buildClusterText(
  symbolIds: string[],
  symbolMap: ReadonlyMap<string, Symbol>,
): string {
  const parts: string[] = [];
  for (const id of symbolIds) {
    const sym = symbolMap.get(id);
    if (!sym) continue;
    let entry = `${sym.name} (${sym.kind})`;
    if (sym.signature) entry += `: ${sym.signature}`;
    parts.push(entry);
  }
  const text = parts.join(", ");
  // Privacy check — ensure no source code leaks (Req 10.6)
  verifyEmbeddingText(text, "cluster classification");
  return text;
}

// ─── SemanticClusterClassifier ────────────────────────────────────────────────

/**
 * Classifies cluster text into a ClusterCategory using embedding similarity.
 *
 * - `initialize()`: generates and caches one embedding per category.
 * - `classify()`: embeds the input text, compares against cached category
 *   embeddings, returns the best match ≥ SEMANTIC_THRESHOLD or "unknown".
 *
 * Requirements: 10.1, 10.2, 10.3, 10.5
 */
export class SemanticClusterClassifier {
  private categoryEmbeddings: Map<ClusterCategory, number[]> | null = null;
  private embedder: EmbeddingAdapter | null = null;

  /**
   * Generate and cache category reference embeddings. (Req 10.5)
   *
   * When the adapter exposes the OPTIONAL batch fast-path (`embedTexts`), all 5
   * category references are embedded in ONE call (Phase 1). On batch failure
   * (the all-or-nothing call throws), fall back to per-item `embedText`. Adapters
   * without `embedTexts` use the per-item path unchanged. Per-cluster
   * `classify()` batching is Phase 2 (out of scope here).
   */
  async initialize(embedder: EmbeddingAdapter): Promise<void> {
    this.embedder = embedder;
    this.categoryEmbeddings = new Map();

    const texts = CLASSIFIABLE_CATEGORIES.map(
      (category) =>
        CATEGORY_REFERENCE_TEXTS[category as Exclude<ClusterCategory, "unknown">],
    );

    let vectors: (Embedding | null)[] | null = null;
    if (typeof embedder.embedTexts === "function" && isEmbeddingBatchEnabled()) {
      try {
        vectors = await embedder.embedTexts(texts);
      } catch {
        // Batch is all-or-nothing — fall back to per-item below.
        vectors = null;
      }
    }

    if (vectors === null) {
      vectors = [];
      for (const text of texts) {
        vectors.push(await embedder.embedText(text));
      }
    }

    for (let i = 0; i < CLASSIFIABLE_CATEGORIES.length; i++) {
      const embedding = vectors[i] ?? null;
      if (embedding) {
        this.categoryEmbeddings.set(CLASSIFIABLE_CATEGORIES[i], embedding.vector);
      }
    }
  }

  /** Whether the classifier has been initialized with cached embeddings. */
  isInitialized(): boolean {
    return this.categoryEmbeddings !== null && this.embedder !== null;
  }

  /**
   * Classify cluster text by cosine similarity against category embeddings.
   * Returns the highest-scoring category ≥ SEMANTIC_THRESHOLD, or "unknown".
   * (Req 10.1, 10.2, 10.3)
   */
  async classify(clusterText: string): Promise<ClusterCategory> {
    if (!this.embedder || !this.categoryEmbeddings) {
      return "unknown";
    }

    const embedding = await this.embedder.embedText(clusterText);
    if (!embedding) return "unknown";

    let bestCategory: ClusterCategory = "unknown";
    let bestScore = -Infinity;

    for (const [category, catVector] of this.categoryEmbeddings) {
      const score = cosineSimilarity(embedding.vector, catVector);
      if (score > bestScore) {
        bestScore = score;
        bestCategory = category;
      }
    }

    return bestScore >= SEMANTIC_THRESHOLD ? bestCategory : "unknown";
  }
}
