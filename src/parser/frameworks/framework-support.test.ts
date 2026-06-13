/**
 * Property tests for FrameworkSupport validation.
 * Property 21: Framework Support Invariant
 * Requirements: 25.1, 25.2, 25.3, 25.4
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import type { FrameworkSupport, Language, TracingLevel } from "../../core/domain.js";
import { validateFrameworkSupport, assertValidFrameworkSupport } from "./framework-support.js";

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const languageArb = fc.constantFrom<Language>(
  "php", "typescript", "javascript", "python", "java",
  "go", "rust", "c", "cpp", "csharp", "ruby", "swift",
);

const tracingLevelArb = fc.constantFrom<TracingLevel>("full", "partial", "developing");

const frameworkSupportArb = fc.record<FrameworkSupport>({
  framework: fc.string({ minLength: 1 }),
  language: languageArb,
  apiEndpoints: fc.boolean(),
  controllers: fc.boolean(),
  dbModels: fc.boolean(),
  supportedORMs: fc.array(fc.string({ minLength: 1 })),
  tracingLevel: tracingLevelArb,
});

// ─── Property 21: Framework Support Invariant ────────────────────────────────

describe("Property 21: Framework Support Invariant", () => {
  /**
   * Req 25.1 — at least one capability must be enabled
   */
  it("rejects frameworks with no capabilities enabled", () => {
    fc.assert(
      fc.property(
        frameworkSupportArb.map((fs) => ({
          ...fs,
          apiEndpoints: false,
          controllers: false,
          dbModels: false,
        })),
        (fs) => {
          const result = validateFrameworkSupport(fs);
          expect(result.valid).toBe(false);
          expect(result.errors.some((e) => e.rule === "atLeastOneCapability")).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("accepts frameworks with at least one capability enabled", () => {
    const validArb = frameworkSupportArb.filter(
      (fs) => fs.apiEndpoints || fs.controllers || fs.dbModels,
    ).map((fs) => ({
      ...fs,
      // Ensure ORM constraint is satisfied when dbModels is true
      supportedORMs: fs.dbModels && fs.supportedORMs.length === 0 ? ["SomeORM"] : fs.supportedORMs,
      // Fix tracingLevel to avoid other violations
      tracingLevel: "developing" as TracingLevel,
    }));

    fc.assert(
      fc.property(validArb, (fs) => {
        const result = validateFrameworkSupport(fs);
        expect(result.errors.some((e) => e.rule === "atLeastOneCapability")).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Req 25.2 — supportedORMs must be non-empty when dbModels is true
   */
  it("rejects dbModels=true with empty supportedORMs", () => {
    fc.assert(
      fc.property(
        frameworkSupportArb.map((fs) => ({
          ...fs,
          dbModels: true,
          supportedORMs: [],
        })),
        (fs) => {
          const result = validateFrameworkSupport(fs);
          expect(result.valid).toBe(false);
          expect(result.errors.some((e) => e.rule === "ormRequiredForDbModels")).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("accepts dbModels=true with non-empty supportedORMs", () => {
    fc.assert(
      fc.property(
        frameworkSupportArb.map((fs) => ({
          ...fs,
          dbModels: true,
          supportedORMs: ["Eloquent"],
          tracingLevel: "developing" as TracingLevel,
        })),
        (fs) => {
          const result = validateFrameworkSupport(fs);
          expect(result.errors.some((e) => e.rule === "ormRequiredForDbModels")).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("accepts dbModels=false with empty supportedORMs", () => {
    fc.assert(
      fc.property(
        frameworkSupportArb.map((fs) => ({
          ...fs,
          dbModels: false,
          supportedORMs: [],
          tracingLevel: "developing" as TracingLevel,
        })).filter((fs) => fs.apiEndpoints || fs.controllers),
        (fs) => {
          const result = validateFrameworkSupport(fs);
          expect(result.errors.some((e) => e.rule === "ormRequiredForDbModels")).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Req 25.3 — tracingLevel "full" requires all three capabilities
   */
  it("rejects tracingLevel=full when any capability is missing", () => {
    const incompleteFullArb = frameworkSupportArb
      .map((fs) => ({ ...fs, tracingLevel: "full" as TracingLevel }))
      .filter((fs) => !(fs.apiEndpoints && fs.controllers && fs.dbModels));

    fc.assert(
      fc.property(incompleteFullArb, (fs) => {
        const result = validateFrameworkSupport(fs);
        expect(result.errors.some((e) => e.rule === "fullTracingRequiresAllCapabilities")).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("accepts tracingLevel=full when all three capabilities are enabled", () => {
    fc.assert(
      fc.property(
        frameworkSupportArb.map((fs) => ({
          ...fs,
          tracingLevel: "full" as TracingLevel,
          apiEndpoints: true,
          controllers: true,
          dbModels: true,
          supportedORMs: fs.supportedORMs.length > 0 ? fs.supportedORMs : ["SomeORM"],
        })),
        (fs) => {
          const result = validateFrameworkSupport(fs);
          expect(result.errors.some((e) => e.rule === "fullTracingRequiresAllCapabilities")).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Req 25.4 — tracingLevel "partial" requires at least one but not all capabilities
   */
  it("rejects tracingLevel=partial when all three capabilities are enabled", () => {
    fc.assert(
      fc.property(
        frameworkSupportArb.map((fs) => ({
          ...fs,
          tracingLevel: "partial" as TracingLevel,
          apiEndpoints: true,
          controllers: true,
          dbModels: true,
          supportedORMs: ["SomeORM"],
        })),
        (fs) => {
          const result = validateFrameworkSupport(fs);
          expect(result.errors.some((e) => e.rule === "partialTracingRequiresPartialCapabilities")).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects tracingLevel=partial when no capabilities are enabled", () => {
    fc.assert(
      fc.property(
        frameworkSupportArb.map((fs) => ({
          ...fs,
          tracingLevel: "partial" as TracingLevel,
          apiEndpoints: false,
          controllers: false,
          dbModels: false,
        })),
        (fs) => {
          const result = validateFrameworkSupport(fs);
          expect(result.errors.some((e) => e.rule === "partialTracingRequiresPartialCapabilities")).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("accepts tracingLevel=partial with exactly one or two capabilities", () => {
    const partialArb = frameworkSupportArb
      .map((fs) => ({
        ...fs,
        tracingLevel: "partial" as TracingLevel,
        supportedORMs: fs.dbModels ? (fs.supportedORMs.length > 0 ? fs.supportedORMs : ["SomeORM"]) : fs.supportedORMs,
      }))
      .filter((fs) => {
        const count = [fs.apiEndpoints, fs.controllers, fs.dbModels].filter(Boolean).length;
        return count >= 1 && count < 3;
      });

    fc.assert(
      fc.property(partialArb, (fs) => {
        const result = validateFrameworkSupport(fs);
        expect(result.errors.some((e) => e.rule === "partialTracingRequiresPartialCapabilities")).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Unit tests: known framework definitions ──────────────────────────────────

describe("validateFrameworkSupport — known frameworks", () => {
  const validFull: FrameworkSupport = {
    framework: "NestJS",
    language: "typescript",
    apiEndpoints: true,
    controllers: true,
    dbModels: true,
    supportedORMs: ["Prisma", "TypeORM"],
    tracingLevel: "full",
  };

  const validPartial: FrameworkSupport = {
    framework: "Express",
    language: "javascript",
    apiEndpoints: true,
    controllers: false,
    dbModels: true,
    supportedORMs: ["Prisma", "TypeORM", "Mongoose"],
    tracingLevel: "partial",
  };

  it("accepts a valid full-tracing framework", () => {
    expect(validateFrameworkSupport(validFull)).toEqual({ valid: true, errors: [] });
  });

  it("accepts a valid partial-tracing framework", () => {
    expect(validateFrameworkSupport(validPartial)).toEqual({ valid: true, errors: [] });
  });

  it("assertValidFrameworkSupport does not throw for valid definitions", () => {
    expect(() => assertValidFrameworkSupport(validFull)).not.toThrow();
    expect(() => assertValidFrameworkSupport(validPartial)).not.toThrow();
  });

  it("assertValidFrameworkSupport throws for invalid definitions", () => {
    const invalid: FrameworkSupport = {
      ...validFull,
      apiEndpoints: false,
      controllers: false,
      dbModels: false,
    };
    expect(() => assertValidFrameworkSupport(invalid)).toThrow("Invalid FrameworkSupport");
  });

  it("collects multiple errors when multiple rules are violated", () => {
    const multiViolation: FrameworkSupport = {
      framework: "Broken",
      language: "typescript",
      apiEndpoints: false,
      controllers: false,
      dbModels: true,   // dbModels=true but no ORMs
      supportedORMs: [],
      tracingLevel: "full", // full but not all capabilities
    };
    const result = validateFrameworkSupport(multiViolation);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});
