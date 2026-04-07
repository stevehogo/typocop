// Unified prefix validation for PostgreSQL tables and Neo4j labels/relationship types.
// Rules satisfy both databases: lowercase letter start, alphanumeric + underscores, max 32 chars.

const PREFIX_PATTERN = /^[a-z][a-z0-9_]*$/;
const MAX_PREFIX_LENGTH = 32;

export interface ValidationResult {
  readonly valid: boolean;
  readonly error?: string;
  readonly suggestion?: string;
  readonly normalized?: string;
}

export interface IPrefixValidator {
  validate(prefix: string): ValidationResult;
  normalize(prefix: string): string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hasUppercase(prefix: string): boolean {
  return /[A-Z]/.test(prefix);
}

function hasInvalidChars(prefix: string): boolean {
  return /[^a-z0-9_]/.test(prefix);
}

function startsWithLetter(prefix: string): boolean {
  return /^[a-z]/.test(prefix);
}

// ─── PrefixValidator ──────────────────────────────────────────────────────────

export class PrefixValidator implements IPrefixValidator {
  /**
   * Validate a prefix string against unified naming rules.
   * Empty string is valid (disables prefixing).
   */
  validate(prefix: string): ValidationResult {
    // Empty string disables prefixing — always valid
    if (prefix === "") {
      return { valid: true, normalized: "" };
    }

    // Reject uppercase letters with a lowercase suggestion
    if (hasUppercase(prefix)) {
      const suggestion = prefix.toLowerCase();
      return {
        valid: false,
        error: `Prefix "${prefix}" must be lowercase only. Uppercase letters are not allowed.`,
        suggestion,
      };
    }

    // Reject special characters (hyphens, dots, spaces, etc.)
    if (hasInvalidChars(prefix)) {
      // Suggest replacing hyphens with underscores if that's the only issue
      const withUnderscores = prefix.replace(/-/g, "_");
      const suggestion = /^[a-z][a-z0-9_]*$/.test(withUnderscores) ? withUnderscores : undefined;
      return {
        valid: false,
        error: `Prefix "${prefix}" contains invalid characters. Only lowercase letters, digits, and underscores are allowed.`,
        suggestion,
      };
    }

    // Must start with a lowercase letter
    if (!startsWithLetter(prefix)) {
      return {
        valid: false,
        error: `Prefix "${prefix}" must start with a lowercase letter (a–z).`,
      };
    }

    // Strip trailing underscore for length check (it will be appended during normalization)
    const base = prefix.endsWith("_") ? prefix.slice(0, -1) : prefix;
    const normalized = base + "_";

    // Reject if normalized form exceeds max length
    if (normalized.length > MAX_PREFIX_LENGTH) {
      const truncated = base.slice(0, MAX_PREFIX_LENGTH - 1) + "_";
      return {
        valid: false,
        error: `Prefix "${prefix}" is too long. Maximum length is ${MAX_PREFIX_LENGTH} characters (including trailing underscore).`,
        suggestion: truncated,
      };
    }

    // Valid — return with normalized form
    return { valid: true, normalized };
  }

  /**
   * Normalize a valid prefix by appending an underscore if missing.
   * Throws if the prefix is invalid.
   */
  normalize(prefix: string): string {
    if (prefix === "") {
      return "";
    }

    const result = this.validate(prefix);
    if (!result.valid) {
      throw new Error(result.error ?? `Invalid prefix: "${prefix}"`);
    }

    // validate() always sets normalized for valid non-empty prefixes
    return result.normalized!;
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

export const prefixValidator: IPrefixValidator = new PrefixValidator();
