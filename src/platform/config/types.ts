/**
 * Configuration types for Ollama, HuggingFace embeddings, and LadybugDB.
 * Requirements: 4.1, 4.3, 4.6, 5.1, 5.2, 5.3, 5.4, 5.5
 */

/**
 * Obsidian vault export configuration.
 * Lives here (not in apps/cli) so application/export-render can depend on it
 * without a back-edge into the CLI app (breaks Cycle B).
 */
export interface ObsidianExportConfig {
  readonly outputPath: string;
  readonly verbose: boolean;
}

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
  /** Quantization/precision. Default: "q8" (~2x faster than fp32 on CPU, ~0.99 cosine alignment). */
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

export type LadybugRuntimeMode = "server" | "client";

export interface LadybugServerConfig {
  readonly runtimeMode: LadybugRuntimeMode;
  readonly prefix: string;
  readonly dbPath: string;
  readonly host: string;
  readonly port: number;
  readonly authToken: string;
  readonly grpcMaxMessageBytes: number;
  readonly maxConcurrency: number;
  readonly maxQueue: number;
  readonly idleTtlMs: number;
  readonly discoveryPath: string;
  /** Grace period (ms) to drain in-flight work before escalating shutdown. */
  readonly shutdownGraceMs: number;
  /** Hard deadline (ms) for the whole shutdown sequence before force-exit. */
  readonly shutdownHardMs: number;
}

export interface LadybugClientConfig {
  readonly runtimeMode: "client";
  readonly prefix: string;
  readonly dbPath: string;
  readonly serverUrl: string;
  readonly authToken: string;
  readonly grpcMaxMessageBytes: number;
  readonly autostart: boolean;
  readonly startupTimeoutMs: number;
  readonly lockPath: string;
  readonly discoveryPath: string;
}

/** Full application configuration combining prefix, Ollama, embedding, and LadybugDB settings. */
export interface FullConfig {
  readonly prefix: string;
  readonly ollama: OllamaConfig;
  readonly embedding: EmbeddingConfig;
  readonly ladybugdb: LadybugDBConfig & {
    readonly runtimeMode: LadybugRuntimeMode;
    readonly serverUrl: string;
    readonly serverHost: string;
    readonly serverPort: number;
    readonly serverAuthToken: string;
    readonly grpcMaxMessageBytes: number;
    readonly serverMaxConcurrency: number;
    readonly serverMaxQueue: number;
    readonly serverAutostart: boolean;
    readonly serverStartupTimeoutMs: number;
    readonly serverLockPath: string;
    readonly serverDiscoveryPath: string;
    readonly serverIdleTtlMs: number;
    readonly serverShutdownGraceMs: number;
    readonly serverShutdownHardMs: number;
  };
  readonly loadedAt: Date;
  readonly source: "environment" | "env-file" | "default";
}
