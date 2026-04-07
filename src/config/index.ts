// Public API for the config module.

export { ConfigurationManager, configurationManager } from "./configuration-manager.js";
export type { IConfigurationManager, PrefixConfiguration } from "./configuration-manager.js";
export { PrefixValidator, prefixValidator } from "./prefix-validator.js";
export type { IPrefixValidator, ValidationResult } from "./prefix-validator.js";
export { ConfigurationError, PrefixValidationError } from "./errors.js";
