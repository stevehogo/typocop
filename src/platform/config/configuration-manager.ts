// Configuration Manager — loads, validates, and exposes prefix, Ollama, and LadybugDB config.

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

import { PrefixValidator } from "./prefix-validator.js";
import { PrefixValidationError, OllamaConfigError, EmbeddingConfigError, LadybugConfigError } from "./errors.js";
import {
  DEFAULT_GRPC_MAX_MESSAGE_BYTES,
  DEFAULT_SHUTDOWN_GRACE_MS,
  DEFAULT_SHUTDOWN_HARD_MS,
  DEFAULT_DB_LOCK_STALE_MS,
  DEFAULT_DB_LOCK_RETRIES,
  GRPC_MAX_MESSAGE_BYTES_ENV,
  SHUTDOWN_GRACE_MS_ENV,
  SHUTDOWN_HARD_MS_ENV,
  DB_LOCK_STALE_MS_ENV,
  DB_LOCK_RETRIES_ENV,
} from "../utils/limits.js";
import type { ValidationResult } from "./prefix-validator.js";
import type {
  OllamaConfig,
  LadybugDBConfig,
  EmbeddingProvider,
  HuggingFaceConfig,
  EmbeddingConfig,
  FullConfig,
  LadybugRuntimeMode,
} from "./types.js";

export type { FullConfig } from "./types.js";

export interface IConfigurationManager {
  initialize(): Promise<void>;
  getPrefix(): string;
  validate(prefix: string): ValidationResult;
  getConfiguration(): FullConfig;
}

const DEFAULT_PREFIX = "tpc_";
const ENV_VAR = "TYPOCOP_PREFIX";
const VALID_RUNTIME_MODES: readonly LadybugRuntimeMode[] = ["server", "client"] as const;

const OLLAMA_DEFAULTS: OllamaConfig = {
  enabled: false,
  url: "http://localhost:11434",
  /** Default embedding model for Ollama. Matches HuggingFace mxbai-embed-large-v1. */
  model: "mxbai-embed-large",
  /** Default dimensions for mxbai-embed-large. */
  dimensions: 1024,
};

const LADYBUG_SERVER_DEFAULTS = {
  runtimeMode: "server" as LadybugRuntimeMode,
  serverUrl: "grpc://127.0.0.1:7617",
  serverHost: "127.0.0.1",
  serverPort: 7617,
  serverAuthToken: "",
  grpcMaxMessageBytes: DEFAULT_GRPC_MAX_MESSAGE_BYTES,
  serverMaxConcurrency: 4,
  serverMaxQueue: 256,
  serverAutostart: false,
  serverStartupTimeoutMs: 10_000,
  serverIdleTtlMs: 0,
  serverShutdownGraceMs: DEFAULT_SHUTDOWN_GRACE_MS,
  serverShutdownHardMs: DEFAULT_SHUTDOWN_HARD_MS,
  serverLockStaleMs: DEFAULT_DB_LOCK_STALE_MS,
  serverLockRetries: DEFAULT_DB_LOCK_RETRIES,
};

const VALID_PROVIDERS: readonly EmbeddingProvider[] = ["huggingface", "ollama", "none"] as const;
const VALID_DTYPES: readonly HuggingFaceConfig["dtype"][] = ["fp32", "fp16", "q8"] as const;
const VALID_POOLINGS: readonly HuggingFaceConfig["pooling"][] = ["cls", "mean"] as const;

export class ConfigurationManager implements IConfigurationManager {
  private configuration: FullConfig | null = null;
  private readonly validator: PrefixValidator;

  constructor() {
    this.validator = new PrefixValidator();
  }

  async initialize(): Promise<void> {
    const prefix = this.loadPrefix();
    const ollama = this.loadOllamaConfig();
    const embedding = this.loadEmbeddingConfig();
    const ladybugdb = await this.loadLadybugDBConfig(prefix);

    const source = this.resolveSource();

    this.configuration = {
      prefix,
      ollama,
      embedding,
      ladybugdb,
      loadedAt: new Date(),
      source,
    };

    console.error(`[typocop] prefix=${prefix} ollama.enabled=${ollama.enabled} embedding.provider=${embedding.provider}`);
  }

  private resolveSource(): "environment" | "env-file" | "default" {
    const hasEnv = Object.keys(process.env).some((key) =>
      key === ENV_VAR ||
      key.startsWith("OLLAMA_") ||
      key.startsWith("HF_") ||
      key === "EMBEDDING_PROVIDER" ||
      key.startsWith("LADYBUG_"),
    );
    if (!hasEnv) return "default";
    return "environment";
  }

  private loadPrefix(): string {
    const raw = process.env[ENV_VAR];

    if (raw === undefined || raw === "") {
      return DEFAULT_PREFIX;
    }

    const result = this.validator.validate(raw);

    if (!result.valid) {
      throw new PrefixValidationError(
        raw,
        result.error ?? "Invalid prefix",
        result.suggestion,
      );
    }

    return this.validator.normalize(raw);
  }

  private loadOllamaConfig(): OllamaConfig {
    const enabledRaw = process.env["OLLAMA_ENABLED"];
    const enabled =
      enabledRaw !== undefined && enabledRaw.toLowerCase() === "true";

    const url = process.env["OLLAMA_URL"] || OLLAMA_DEFAULTS.url;
    this.validateOllamaUrl(url);

    const model = process.env["OLLAMA_MODEL"] || OLLAMA_DEFAULTS.model;

    const dimensionsRaw = process.env["OLLAMA_DIMENSIONS"];
    const dimensions = dimensionsRaw
      ? this.parseDimensions(dimensionsRaw)
      : OLLAMA_DEFAULTS.dimensions;

    return { enabled, url, model, dimensions };
  }

  /** Load and validate embedding configuration from environment variables. */
  private loadEmbeddingConfig(): EmbeddingConfig {
    const providerRaw = process.env["EMBEDDING_PROVIDER"];
    let provider: EmbeddingProvider;

    if (providerRaw) {
      provider = this.validateProvider(providerRaw);
    } else {
      // Backward compat: infer from OLLAMA_ENABLED
      const ollamaEnabled = process.env["OLLAMA_ENABLED"]?.toLowerCase() === "true";
      provider = ollamaEnabled ? "ollama" : "huggingface";
    }

    const huggingface: HuggingFaceConfig = {
      model: process.env["HF_MODEL"] || "mixedbread-ai/mxbai-embed-large-v1",
      // Default q8: ~2x faster index + query embedding on CPU vs fp32, with ~0.99
      // cosine alignment to fp32 (measured). Override with HF_DTYPE=fp32 for
      // maximum precision. NOTE: index-time and query-time dtype must match — a
      // DB indexed under one dtype should be reindexed if the dtype changes.
      dtype: this.validateDtype(process.env["HF_DTYPE"] || "q8"),
      dimensions: this.parseEmbeddingDimensions(process.env["HF_DIMENSIONS"] || "1024"),
      pooling: this.validatePooling(process.env["HF_POOLING"] || "cls"),
    };

    return { provider, huggingface };
  }

  private validateProvider(raw: string): EmbeddingProvider {
    if (!VALID_PROVIDERS.includes(raw as EmbeddingProvider)) {
      throw new EmbeddingConfigError(
        "EMBEDDING_PROVIDER",
        raw,
        `Must be one of: ${VALID_PROVIDERS.join(", ")}.`,
      );
    }
    return raw as EmbeddingProvider;
  }

  private validateDtype(raw: string): HuggingFaceConfig["dtype"] {
    if (!VALID_DTYPES.includes(raw as HuggingFaceConfig["dtype"])) {
      throw new EmbeddingConfigError(
        "HF_DTYPE",
        raw,
        `Must be one of: ${VALID_DTYPES.join(", ")}.`,
      );
    }
    return raw as HuggingFaceConfig["dtype"];
  }

  private validatePooling(raw: string): HuggingFaceConfig["pooling"] {
    if (!VALID_POOLINGS.includes(raw as HuggingFaceConfig["pooling"])) {
      throw new EmbeddingConfigError(
        "HF_POOLING",
        raw,
        `Must be one of: ${VALID_POOLINGS.join(", ")}.`,
      );
    }
    return raw as HuggingFaceConfig["pooling"];
  }

  private parseEmbeddingDimensions(raw: string): number {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new EmbeddingConfigError(
        "HF_DIMENSIONS",
        raw,
        "Must be a positive integer.",
      );
    }
    return parsed;
  }

  private validateOllamaUrl(url: string): void {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new OllamaConfigError(
          "OLLAMA_URL",
          url,
          "URL must use http:// or https:// protocol.",
        );
      }
    } catch (err: unknown) {
      if (err instanceof OllamaConfigError) throw err;
      throw new OllamaConfigError(
        "OLLAMA_URL",
        url,
        "URL must be a valid HTTP or HTTPS URL.",
      );
    }
  }

  private parseDimensions(raw: string): number {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new OllamaConfigError(
        "OLLAMA_DIMENSIONS",
        raw,
        "Dimensions must be a positive integer.",
      );
    }
    return parsed;
  }

  async loadLadybugDBConfig(prefix: string): Promise<FullConfig["ladybugdb"]> {
    const dbPath = this.resolveConfiguredPath(
      process.env["LADYBUGDB_PATH"],
      this.defaultDbPath(prefix),
    );
    const runtimeMode = this.loadRuntimeMode();
    const serverUrl = this.resolveConfiguredPath(
      process.env["LADYBUG_SERVER_URL"],
      LADYBUG_SERVER_DEFAULTS.serverUrl,
    );
    const serverHost = process.env["LADYBUG_SERVER_HOST"] || LADYBUG_SERVER_DEFAULTS.serverHost;
    const serverPort = this.parsePort(
      process.env["LADYBUG_SERVER_PORT"] || String(LADYBUG_SERVER_DEFAULTS.serverPort),
    );
    const serverAuthToken = process.env["LADYBUG_SERVER_AUTH_TOKEN"] || LADYBUG_SERVER_DEFAULTS.serverAuthToken;
    const grpcMaxMessageBytes = this.parsePositiveInt(
      GRPC_MAX_MESSAGE_BYTES_ENV,
      process.env[GRPC_MAX_MESSAGE_BYTES_ENV] || String(LADYBUG_SERVER_DEFAULTS.grpcMaxMessageBytes),
      1,
    );
    const serverMaxConcurrency = this.parsePositiveInt(
      "LADYBUG_SERVER_MAX_CONCURRENCY",
      process.env["LADYBUG_SERVER_MAX_CONCURRENCY"] || String(LADYBUG_SERVER_DEFAULTS.serverMaxConcurrency),
      1,
    );
    const serverMaxQueue = this.parsePositiveInt(
      "LADYBUG_SERVER_MAX_QUEUE",
      process.env["LADYBUG_SERVER_MAX_QUEUE"] || String(LADYBUG_SERVER_DEFAULTS.serverMaxQueue),
      1,
    );
    const serverAutostart = this.parseBoolean(
      process.env["LADYBUG_SERVER_AUTOSTART"],
      LADYBUG_SERVER_DEFAULTS.serverAutostart,
    );
    const serverStartupTimeoutMs = this.parsePositiveInt(
      "LADYBUG_SERVER_STARTUP_TIMEOUT_MS",
      process.env["LADYBUG_SERVER_STARTUP_TIMEOUT_MS"] || String(LADYBUG_SERVER_DEFAULTS.serverStartupTimeoutMs),
      1,
    );
    const serverIdleTtlMs = this.parsePositiveInt(
      "LADYBUG_SERVER_IDLE_TTL_MS",
      process.env["LADYBUG_SERVER_IDLE_TTL_MS"] || String(LADYBUG_SERVER_DEFAULTS.serverIdleTtlMs),
      0,
    );
    const serverShutdownGraceMs = this.parsePositiveInt(
      SHUTDOWN_GRACE_MS_ENV,
      process.env[SHUTDOWN_GRACE_MS_ENV] || String(LADYBUG_SERVER_DEFAULTS.serverShutdownGraceMs),
      1,
    );
    const serverShutdownHardMs = this.parsePositiveInt(
      SHUTDOWN_HARD_MS_ENV,
      process.env[SHUTDOWN_HARD_MS_ENV] || String(LADYBUG_SERVER_DEFAULTS.serverShutdownHardMs),
      1,
    );
    const serverLockStaleMs = this.parsePositiveInt(
      DB_LOCK_STALE_MS_ENV,
      process.env[DB_LOCK_STALE_MS_ENV] || String(LADYBUG_SERVER_DEFAULTS.serverLockStaleMs),
      1,
    );
    const serverLockRetries = this.parsePositiveInt(
      DB_LOCK_RETRIES_ENV,
      process.env[DB_LOCK_RETRIES_ENV] || String(LADYBUG_SERVER_DEFAULTS.serverLockRetries),
      0,
    );
    const serverLockPath = this.resolveConfiguredPath(
      process.env["LADYBUG_SERVER_LOCK_PATH"],
      this.defaultLockPath(prefix),
    );
    const serverDiscoveryPath = this.resolveConfiguredPath(
      process.env["LADYBUG_SERVER_DISCOVERY_PATH"],
      this.defaultDiscoveryPath(prefix),
    );

    if (runtimeMode === "client") {
      this.validateGrpcUrl(serverUrl);
    }

    await mkdir(dirname(dbPath), { recursive: true });
    await mkdir(dirname(serverLockPath), { recursive: true });
    await mkdir(dirname(serverDiscoveryPath), { recursive: true });

    return {
      dbPath,
      runtimeMode,
      serverUrl,
      serverHost,
      serverPort,
      serverAuthToken,
      grpcMaxMessageBytes,
      serverMaxConcurrency,
      serverMaxQueue,
      serverAutostart,
      serverStartupTimeoutMs,
      serverLockPath,
      serverDiscoveryPath,
      serverIdleTtlMs,
      serverShutdownGraceMs,
      serverShutdownHardMs,
      serverLockStaleMs,
      serverLockRetries,
    };
  }

  private defaultDbPath(prefix: string): string {
    return join(homedir(), ".typocop", prefix, "db.ladybug");
  }

  private defaultLockPath(prefix: string): string {
    return join(homedir(), ".typocop", "locks", `${prefix}-ladybug-server.lock`);
  }

  private defaultDiscoveryPath(prefix: string): string {
    return join(homedir(), ".typocop", prefix, "ladybug-server.json");
  }

  private loadRuntimeMode(): LadybugRuntimeMode {
    const raw = process.env["LADYBUG_RUNTIME_MODE"] || LADYBUG_SERVER_DEFAULTS.runtimeMode;
    if (!VALID_RUNTIME_MODES.includes(raw as LadybugRuntimeMode)) {
      throw new LadybugConfigError(
        "LADYBUG_RUNTIME_MODE",
        raw,
        `Must be one of: ${VALID_RUNTIME_MODES.join(", ")}.`,
      );
    }
    return raw as LadybugRuntimeMode;
  }

  private parsePort(raw: string): number {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new LadybugConfigError(
        "LADYBUG_SERVER_PORT",
        raw,
        "Port must be an integer between 1 and 65535.",
      );
    }
    return port;
  }

  private parsePositiveInt(field: string, raw: string, min: number): number {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min) {
      throw new LadybugConfigError(
        field,
        raw,
        `Must be an integer greater than or equal to ${min}.`,
      );
    }
    return value;
  }

  private parseBoolean(raw: string | undefined, fallback: boolean): boolean {
    if (raw === undefined || raw === "") return fallback;
    return raw.toLowerCase() === "true";
  }

  private resolveConfiguredPath(raw: string | undefined, fallback: string): string {
    const value = raw && raw !== "" ? raw : fallback;
    if (value.startsWith("~/")) {
      return join(homedir(), value.slice(2));
    }
    return value;
  }

  private validateGrpcUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new LadybugConfigError(
        "LADYBUG_SERVER_URL",
        url,
        "URL must be a valid grpc:// URL.",
      );
    }
    if (parsed.protocol !== "grpc:") {
      throw new LadybugConfigError(
        "LADYBUG_SERVER_URL",
        url,
        "URL must use the grpc:// protocol in client mode.",
      );
    }
  }

  getPrefix(): string {
    if (this.configuration === null) {
      throw new Error(
        "ConfigurationManager has not been initialized. Call initialize() before getPrefix().",
      );
    }
    return this.configuration.prefix;
  }

  validate(prefix: string): ValidationResult {
    return this.validator.validate(prefix);
  }

  static validate(prefix: string): ValidationResult {
    return new PrefixValidator().validate(prefix);
  }

  getConfiguration(): FullConfig {
    if (this.configuration === null) {
      throw new Error(
        "ConfigurationManager has not been initialized. Call initialize() before getConfiguration().",
      );
    }
    return this.configuration;
  }
}

// Singleton for use across the application
export const configurationManager = new ConfigurationManager();
