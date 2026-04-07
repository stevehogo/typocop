import { describe, it, expect } from "vitest";
import { ConfigurationError, PrefixValidationError } from "./errors.js";

// ─── 16.1 Error message fields ────────────────────────────────────────────────

describe("PrefixValidationError", () => {
  describe("message includes reason and suggestion", () => {
    it("includes the invalid prefix in the message", () => {
      const err = new PrefixValidationError("MyPrefix", "must be lowercase only");
      expect(err.message).toContain("MyPrefix");
    });

    it("includes the reason in the message", () => {
      const err = new PrefixValidationError("MyPrefix", "must be lowercase only");
      expect(err.message).toContain("must be lowercase only");
    });

    it("includes the suggestion in the message when provided", () => {
      const err = new PrefixValidationError("MyPrefix", "must be lowercase only", "myprefix");
      expect(err.message).toContain("myprefix");
    });

    it("omits suggestion from message when not provided", () => {
      const err = new PrefixValidationError("123bad", "must start with a lowercase letter");
      expect(err.message).not.toContain("Suggestion:");
    });
  });

  describe("structured fields", () => {
    it("exposes prefix field", () => {
      const err = new PrefixValidationError("BAD", "must be lowercase only");
      expect(err.prefix).toBe("BAD");
    });

    it("exposes reason field", () => {
      const err = new PrefixValidationError("BAD", "must be lowercase only");
      expect(err.reason).toBe("must be lowercase only");
    });

    it("exposes suggestion field when provided", () => {
      const err = new PrefixValidationError("BAD", "must be lowercase only", "bad_");
      expect(err.suggestion).toBe("bad_");
    });

    it("suggestion field is undefined when not provided", () => {
      const err = new PrefixValidationError("123bad", "must start with a lowercase letter");
      expect(err.suggestion).toBeUndefined();
    });
  });

  describe("error identity", () => {
    it("is an instance of PrefixValidationError", () => {
      const err = new PrefixValidationError("BAD", "reason");
      expect(err).toBeInstanceOf(PrefixValidationError);
    });

    it("is an instance of ConfigurationError", () => {
      const err = new PrefixValidationError("BAD", "reason");
      expect(err).toBeInstanceOf(ConfigurationError);
    });

    it("is an instance of Error", () => {
      const err = new PrefixValidationError("BAD", "reason");
      expect(err).toBeInstanceOf(Error);
    });

    it("has name PrefixValidationError", () => {
      const err = new PrefixValidationError("BAD", "reason");
      expect(err.name).toBe("PrefixValidationError");
    });
  });
});

describe("ConfigurationError", () => {
  it("exposes prefix, reason, and optional suggestion fields", () => {
    const err = new ConfigurationError("msg", "pfx", "bad reason", "try this");
    expect(err.prefix).toBe("pfx");
    expect(err.reason).toBe("bad reason");
    expect(err.suggestion).toBe("try this");
  });

  it("has name ConfigurationError", () => {
    const err = new ConfigurationError("msg", "pfx", "reason");
    expect(err.name).toBe("ConfigurationError");
  });
});
