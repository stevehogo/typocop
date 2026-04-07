// Configuration Manager — loads, validates, and exposes the TYPOCOP_PREFIX env var.

import { PrefixValidator } from "./prefix-validator.js";
import { PrefixValidationError } from "./errors.js";
import type { ValidationResult } from "./prefix-validator.js";

export interface PrefixConfiguration {
  readonly prefix: string;
  readonly loadedAt: Date;
  readonly source: "environment" | "env-file" | "default";
}

export interface IConfigurationManager {
  initialize(): Promise<void>;
  getPrefix(): string;
  validate(prefix: string): ValidationResult;
  getConfiguration(): PrefixConfiguration;
}

const DEFAULT_PREFIX = "tpc_";
const ENV_VAR = "TYPOCOP_PREFIX";

export class ConfigurationManager implements IConfigurationManager {
  private configuration: PrefixConfiguration | null = null;
  private readonly validator: PrefixValidator;

  constructor() {
    this.validator = new PrefixValidator();
  }

  async initialize(): Promise<void> {
    const raw = process.env[ENV_VAR];

    if (raw === undefined || raw === "") {
      this.configuration = {
        prefix: DEFAULT_PREFIX,
        loadedAt: new Date(),
        source: "default",
      };
      console.error(`[typocop] Using default prefix: ${DEFAULT_PREFIX}`);
      return;
    }

    const result = this.validator.validate(raw);

    if (!result.valid) {
      throw new PrefixValidationError(raw, result.error ?? "Invalid prefix", result.suggestion);
    }

    // normalize() appends underscore if missing
    const normalized = this.validator.normalize(raw);

    this.configuration = {
      prefix: normalized,
      loadedAt: new Date(),
      source: "environment",
    };

    console.error(`[typocop] Using prefix from ${ENV_VAR}: ${normalized}`);
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

  getConfiguration(): PrefixConfiguration {
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
