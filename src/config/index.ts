// Public API for the config module.

export { ConfigurationManager, configurationManager } from "./configuration-manager.js";
export type { IConfigurationManager } from "./configuration-manager.js";
export type { FullConfig } from "./types.js";
export type { OllamaConfig, LadybugDBConfig, EmbeddingProvider, HuggingFaceConfig, EmbeddingConfig } from "./types.js";
export { PrefixValidator, prefixValidator } from "./prefix-validator.js";
export type { IPrefixValidator, ValidationResult } from "./prefix-validator.js";
export { ConfigurationError, PrefixValidationError, OllamaConfigError, EmbeddingConfigError } from "./errors.js";
