/**
 * FrameworkSupport validation rules.
 * Requirements: 25.1, 25.2, 25.3, 25.4
 */
import type { FrameworkSupport } from "../../types/index.js";

export type ValidationError =
  | { rule: "atLeastOneCapability"; message: string }
  | { rule: "ormRequiredForDbModels"; message: string }
  | { rule: "fullTracingRequiresAllCapabilities"; message: string }
  | { rule: "partialTracingRequiresPartialCapabilities"; message: string };

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: ValidationError[];
}

/** Req 25.1 — at least one of apiEndpoints, controllers, or dbModels must be true */
function validateAtLeastOneCapability(fs: FrameworkSupport): ValidationError | null {
  if (!fs.apiEndpoints && !fs.controllers && !fs.dbModels) {
    return {
      rule: "atLeastOneCapability",
      message: `Framework "${fs.framework}" must support at least one of: apiEndpoints, controllers, dbModels`,
    };
  }
  return null;
}

/** Req 25.2 — supportedORMs must be non-empty when dbModels is true */
function validateOrmRequiredForDbModels(fs: FrameworkSupport): ValidationError | null {
  if (fs.dbModels && fs.supportedORMs.length === 0) {
    return {
      rule: "ormRequiredForDbModels",
      message: `Framework "${fs.framework}" has dbModels=true but supportedORMs is empty`,
    };
  }
  return null;
}

/** Req 25.3 — tracingLevel "full" requires all three capabilities */
function validateFullTracingRequiresAllCapabilities(fs: FrameworkSupport): ValidationError | null {
  if (fs.tracingLevel === "full" && !(fs.apiEndpoints && fs.controllers && fs.dbModels)) {
    return {
      rule: "fullTracingRequiresAllCapabilities",
      message: `Framework "${fs.framework}" has tracingLevel="full" but not all capabilities are enabled`,
    };
  }
  return null;
}

/** Req 25.4 — tracingLevel "partial" requires at least one but not all capabilities */
function validatePartialTracingRequiresPartialCapabilities(fs: FrameworkSupport): ValidationError | null {
  if (fs.tracingLevel !== "partial") return null;

  const count = [fs.apiEndpoints, fs.controllers, fs.dbModels].filter(Boolean).length;
  if (count === 0 || count === 3) {
    return {
      rule: "partialTracingRequiresPartialCapabilities",
      message: `Framework "${fs.framework}" has tracingLevel="partial" but must have at least one and not all capabilities enabled (got ${count}/3)`,
    };
  }
  return null;
}

/**
 * Validate a FrameworkSupport definition against all invariants.
 * Returns a ValidationResult with all errors found.
 */
export function validateFrameworkSupport(fs: FrameworkSupport): ValidationResult {
  const errors: ValidationError[] = [
    validateAtLeastOneCapability(fs),
    validateOrmRequiredForDbModels(fs),
    validateFullTracingRequiresAllCapabilities(fs),
    validatePartialTracingRequiresPartialCapabilities(fs),
  ].filter((e): e is ValidationError => e !== null);

  return { valid: errors.length === 0, errors };
}

/**
 * Assert that a FrameworkSupport definition is valid.
 * Throws if any invariant is violated.
 */
export function assertValidFrameworkSupport(fs: FrameworkSupport): void {
  const result = validateFrameworkSupport(fs);
  if (!result.valid) {
    const messages = result.errors.map((e) => e.message).join("; ");
    throw new Error(`Invalid FrameworkSupport: ${messages}`);
  }
}
