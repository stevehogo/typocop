/**
 * Property-based tests for prefix validation.
 *
 * **Validates: Requirements 1.2, 2.1, 2.2, 2.3, 2.4**
 */

import * as fc from "fast-check";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConfigurationManager } from "./configuration-manager.js";
import { PrefixValidator } from "./prefix-validator.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_PREFIX_PATTERN = /^[a-z][a-z0-9_]*$/;
const MAX_NORMALIZED_LENGTH = 32;

// ─── Property 1: Prefix Validation Correctness ────────────────────────────────

describe("Property 1: Prefix Validation Correctness", () => {
  /**
   * **Validates: Requirements 2.1, 2.2, 2.3, 2.4**
   *
   * For any string input, the prefix validator SHALL accept only strings
   * matching `^[a-z][a-z0-9_]*$` with length ≤ 32 characters (normalized
   * form), and SHALL automatically append an underscore if the string doesn't
   * end with one. Empty string SHALL be accepted as-is.
   */

  const validator = new PrefixValidator();

  it("accepts only strings matching the valid pattern (arbitrary strings)", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = validator.validate(input);

        if (input === "") {
          // Empty string is always valid
          expect(result.valid).toBe(true);
          return;
        }

        // Strip trailing underscore for pattern check (normalization adds it)
        const base = input.endsWith("_") ? input.slice(0, -1) : input;
        const normalized = base + "_";
        const matchesPattern = VALID_PREFIX_PATTERN.test(base);
        const withinLength = normalized.length <= MAX_NORMALIZED_LENGTH;

        if (matchesPattern && withinLength) {
          expect(result.valid).toBe(true);
          expect(result.normalized).toBe(normalized);
        } else {
          expect(result.valid).toBe(false);
          expect(result.error).toBeDefined();
        }
      }),
      { numRuns: 100 },
    );
  });

  it("accepts all strings matching the valid pattern", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9_]{0,30}$/), (input) => {
        const result = validator.validate(input);
        expect(result.valid).toBe(true);
        // Normalized form always ends with exactly one underscore
        const expectedNormalized = input.endsWith("_") ? input : input + "_";
        expect(result.normalized).toBe(expectedNormalized);
      }),
      { numRuns: 100 },
    );
  });

  it("rejects all strings containing uppercase letters", () => {
    fc.assert(
      fc.property(fc.stringMatching(/[A-Z]/), (input) => {
        const result = validator.validate(input);
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
      }),
      { numRuns: 100 },
    );
  });

  it("accepts empty string as-is (disables prefixing)", () => {
    const result = validator.validate("");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("");
  });

  it("rejects prefixes whose normalized form exceeds 32 characters", () => {
    fc.assert(
      fc.property(
        // Generate valid-pattern strings of length >= 32 that don't end with _
        // so normalized = input + "_" has length >= 33, exceeding the 32-char limit
        fc.stringMatching(/^[a-z][a-z0-9_]{31,}[a-z0-9]$/),
        (input) => {
          const result = validator.validate(input);
          expect(result.valid).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 2: Default Prefix Resolution ────────────────────────────────────

describe("Property 2: Default Prefix Resolution", () => {
  /**
   * **Validates: Requirement 1.2**
   *
   * For any environment state, when TYPOCOP_PREFIX is not set the effective
   * prefix SHALL be `tpc_`.
   */

  const ENV_VAR = "TYPOCOP_PREFIX";
  let savedValue: string | undefined;

  beforeEach(() => {
    savedValue = process.env[ENV_VAR];
  });

  afterEach(() => {
    if (savedValue === undefined) {
      delete process.env[ENV_VAR];
    } else {
      process.env[ENV_VAR] = savedValue;
    }
  });

  it("resolves to tpc_ when TYPOCOP_PREFIX is unset, regardless of other env state", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Simulate arbitrary other env vars being set (irrelevant to prefix)
        fc.record({
          someOtherVar: fc.string(),
          anotherVar: fc.nat().map(String),
        }),
        async (_otherEnv) => {
          delete process.env[ENV_VAR];

          const manager = new ConfigurationManager();
          await manager.initialize();

          expect(manager.getPrefix()).toBe("tpc_");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("resolves to tpc_ when TYPOCOP_PREFIX is explicitly empty string", async () => {
    process.env[ENV_VAR] = "";
    const manager = new ConfigurationManager();
    await manager.initialize();
    expect(manager.getPrefix()).toBe("tpc_");
  });
});

// ─── Property 3: Prefix Normalization Idempotence ─────────────────────────────

describe("Property 3: Prefix Normalization Idempotence", () => {
  /**
   * **Validates: Requirement 2.4**
   *
   * For any valid prefix, normalizing it twice produces the same result as
   * normalizing once: normalize(normalize(x)) === normalize(x)
   */

  const validator = new PrefixValidator();

  it("normalize is idempotent for all valid prefixes without trailing underscore", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9_]{0,30}$/), (input) => {
        const once = validator.normalize(input);
        const twice = validator.normalize(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 100 },
    );
  });

  it("normalize is idempotent for valid prefixes already ending with underscore", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9_]{0,29}$/).map((s) => s + "_"),
        (input) => {
          const once = validator.normalize(input);
          const twice = validator.normalize(once);
          expect(twice).toBe(once);
        },
      ),
      { numRuns: 100 },
    );
  });
});
