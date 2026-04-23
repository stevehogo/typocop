/**
 * Configuration types for Ollama, HuggingFace embeddings, and LadybugDB.
 * Requirements: 4.1, 4.3, 4.6, 5.1, 5.2, 5.3, 5.4, 5.5
 */

/** Ollama embedding service configuration. */
export interface OllamaConfig {
  /** Whether Ollama embeddings are enabled. Default: false. (Req 5.1) */
  readonly enabled: boolean;
  /** Ollama HTTP API URL. Default: "http://localhost:11434". (Req 5.2) */
  readonly url: string;
  /** Ollama embedding model name. Default: "mxbai-embed-large". (Req 5.3) */
  readonly model: string;
  /** Embedding vector dimensions. Default: 1024. Must be a positive integer. (Req 5.4) */
  readonly dimensions: number;
}

/** Embedding provider selection. (Req 4.1) */
export type EmbeddingProvider = "huggingface" | "ollama" | "none";

/** HuggingFace in-process embedding configuration. (Req 4.3, 4.6) */
export interface HuggingFaceConfig {
  /** Model identifier on HuggingFace Hub. Default: "mixedbread-ai/mxbai-embed-large-v1". */
  readonly model: string;
  /** Quantization/precision. Default: "fp32". */
  readonly dtype: "fp32" | "fp16" | "q8";
  /** Expected embedding dimensions. Default: 1024. */
  readonly dimensions: number;
  /** Pooling strategy. Default: "cls". */
  readonly pooling: "cls" | "mean";
}

/** Combined embedding configuration with provider selection. (Req 4.1, 4.3) */
export interface EmbeddingConfig {
  /** Active embedding provider. */
  readonly provider: EmbeddingProvider;
  /** HuggingFace-specific settings (used when provider is "huggingface"). */
  readonly huggingface: HuggingFaceConfig;
}

/** LadybugDB storage configuration. */
export interface LadybugDBConfig {
  /** Database file path. Default: "~/.typocop/{prefix}/db.ladybug". (Req 5.5) */
  readonly dbPath: string;
}

/** Full application configuration combining prefix, Ollama, embedding, and LadybugDB settings. */
export interface FullConfig {
  readonly prefix: string;
  readonly ollama: OllamaConfig;
  readonly embedding: EmbeddingConfig;
  readonly ladybugdb: LadybugDBConfig;
  readonly loadedAt: Date;
  readonly source: "environment" | "env-file" | "default";
}
