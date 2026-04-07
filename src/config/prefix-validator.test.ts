import { describe, it, expect } from "vitest";
import { PrefixValidator } from "./prefix-validator.js";

const validator = new PrefixValidator();

// ─── validate() ───────────────────────────────────────────────────────────────

describe("PrefixValidator.validate", () => {
  describe("valid prefixes", () => {
    it("accepts tpc_ (already has underscore)", () => {
      const result = validator.validate("tpc_");
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe("tpc_");
    });

    it("accepts myprefix_", () => {
      const result = validator.validate("myprefix_");
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe("myprefix_");
    });

    it("accepts single letter a_", () => {
      const result = validator.validate("a_");
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe("a_");
    });

    it("accepts alphanumeric a1_", () => {
      const result = validator.validate("a1_");
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe("a1_");
    });

    it("accepts prefix with digits in middle like abc123_", () => {
      const result = validator.validate("abc123_");
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe("abc123_");
    });
  });

  describe("auto-append underscore", () => {
    it("normalizes tpc → tpc_", () => {
      const result = validator.validate("tpc");
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe("tpc_");
    });

    it("normalizes myprefix → myprefix_", () => {
      const result = validator.validate("myprefix");
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe("myprefix_");
    });

    it("normalizes a → a_", () => {
      const result = validator.validate("a");
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe("a_");
    });
  });

  describe("empty string", () => {
    it("accepts empty string (disables prefixing)", () => {
      const result = validator.validate("");
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe("");
    });
  });

  describe("reject uppercase letters", () => {
    it("rejects MyPrefix and suggests myprefix", () => {
      const result = validator.validate("MyPrefix");
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/lowercase/i);
      expect(result.suggestion).toBe("myprefix");
    });

    it("rejects TPC and suggests tpc", () => {
      const result = validator.validate("TPC");
      expect(result.valid).toBe(false);
      expect(result.suggestion).toBe("tpc");
    });

    it("rejects mixed case abc_Def and suggests abc_def", () => {
      const result = validator.validate("abc_Def");
      expect(result.valid).toBe(false);
      expect(result.suggestion).toBe("abc_def");
    });
  });

  describe("reject special characters", () => {
    it("rejects my-prefix (hyphen)", () => {
      const result = validator.validate("my-prefix");
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("rejects my.prefix (dot)", () => {
      const result = validator.validate("my.prefix");
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("rejects 'my prefix' (space)", () => {
      const result = validator.validate("my prefix");
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("rejects prefix with @ symbol", () => {
      const result = validator.validate("my@prefix");
      expect(result.valid).toBe(false);
    });
  });

  describe("reject too long prefix", () => {
    it("rejects prefix whose normalized form exceeds 32 characters", () => {
      // 32 chars + underscore = 33 → too long
      const longPrefix = "a".repeat(32);
      const result = validator.validate(longPrefix);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/too long|maximum/i);
    });

    it("accepts prefix whose normalized form is exactly 32 characters", () => {
      // 31 chars + underscore = 32 → valid
      const prefix = "a".repeat(31);
      const result = validator.validate(prefix);
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(prefix + "_");
    });

    it("accepts prefix that already ends with _ and is exactly 32 chars", () => {
      // 31 chars + _ = 32 → valid
      const prefix = "a".repeat(31) + "_";
      const result = validator.validate(prefix);
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(prefix);
    });
  });
});

// ─── normalize() ──────────────────────────────────────────────────────────────

describe("PrefixValidator.normalize", () => {
  it("appends underscore to tpc → tpc_", () => {
    expect(validator.normalize("tpc")).toBe("tpc_");
  });

  it("leaves tpc_ unchanged", () => {
    expect(validator.normalize("tpc_")).toBe("tpc_");
  });

  it("returns empty string for empty input", () => {
    expect(validator.normalize("")).toBe("");
  });

  it("throws for invalid prefix (uppercase)", () => {
    expect(() => validator.normalize("MyPrefix")).toThrow();
  });

  it("throws for invalid prefix (hyphen)", () => {
    expect(() => validator.normalize("my-prefix")).toThrow();
  });
});
