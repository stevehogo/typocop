// Typed error classes for configuration failures.

export class ConfigurationError extends Error {
  constructor(
    message: string,
    public readonly prefix: string,
    public readonly reason: string,
    public readonly suggestion?: string,
  ) {
    super(message);
    this.name = "ConfigurationError";
    Error.captureStackTrace(this, this.constructor);
  }
}

export class PrefixValidationError extends ConfigurationError {
  constructor(prefix: string, reason: string, suggestion?: string) {
    super(
      `Invalid prefix: "${prefix}". ${reason}${suggestion ? ` Suggestion: ${suggestion}` : ""}`,
      prefix,
      reason,
      suggestion,
    );
    this.name = "PrefixValidationError";
  }
}

export class OllamaConfigError extends ConfigurationError {
  constructor(field: string, value: string, reason: string) {
    super(
      `Invalid Ollama config: ${field}="${value}". ${reason}`,
      field,
      reason,
    );
    this.name = "OllamaConfigError";
  }
}

export class EmbeddingConfigError extends ConfigurationError {
  constructor(field: string, value: string, reason: string) {
    super(
      `Invalid embedding config: ${field}="${value}". ${reason}`,
      field,
      reason,
    );
    this.name = "EmbeddingConfigError";
  }
}

export class LadybugConfigError extends ConfigurationError {
  constructor(field: string, value: string, reason: string) {
    super(
      `Invalid LadybugDB config: ${field}="${value}". ${reason}`,
      field,
      reason,
    );
    this.name = "LadybugConfigError";
  }
}
