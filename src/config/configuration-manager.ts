// Configuration Manager — loads, validates, and exposes prefix, Ollama, and LadybugDB config.

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

import { PrefixValidator } from "./prefix-validator.js";
import { PrefixValidationError, OllamaConfigError, EmbeddingConfigError } from "./errors.js";
import type { ValidationResult } from "./prefix-validator.js";
import type { OllamaConfig, LadybugDBConfig, EmbeddingProvider, HuggingFaceConfig, EmbeddingConfig, FullConfig } from "./types.js";

export type { FullConfig } from "./types.js";

export interface IConfigurationManager {
  initialize(): Promise<void>;
  getPrefix(): string;
  validate(prefix: string): ValidationResult;
  getConfiguration(): FullConfig;
}

const DEFAULT_PREFIX = "tpc_";
const ENV_VAR = "TYPOCOP_PREFIX";

const OLLAMA_DEFAULTS: OllamaConfig = {
  enabled: false,
  url: "http://localhost:11434",
  /** Default embedding model for Ollama. Matches HuggingFace mxbai-embed-large-v1. */
  model: "mxbai-embed-large",
  /** Default dimensions for mxbai-embed-large. */
  dimensions: 1024,
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

    console.log(`[typocop] prefix=${prefix} ollama.enabled=${ollama.enabled} embedding.provider=${embedding.provider}`);
  }

  private resolveSource(): "environment" | "env-file" | "default" {
    const raw = process.env[ENV_VAR];
    if (raw === undefined || raw === "") return "default";
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
      dtype: this.validateDtype(process.env["HF_DTYPE"] || "fp32"),
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

  async loadLadybugDBConfig(prefix: string): Promise<LadybugDBConfig> {
    const envPath = process.env["LADYBUGDB_PATH"];
    const dbPath = envPath || this.defaultDbPath(prefix);

    // Create parent directory — Kùzu creates the database file itself
    await mkdir(dirname(dbPath), { recursive: true });

    return { dbPath };
  }

  private defaultDbPath(prefix: string): string {
    const base = prefix.endsWith("_") ? prefix.slice(0, -1) : prefix;
    return join(homedir(), ".typocop", base, "db.ladybug");
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
