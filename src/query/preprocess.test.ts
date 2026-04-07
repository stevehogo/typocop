/**
 * Unit tests for query preprocessing.
 * 
 * Validates: Requirements 22.3
 */
import { describe, it, expect } from "vitest";
import { preprocessQuery, isValidQuery } from "./preprocess.js";

describe("preprocessQuery", () => {
  it("converts to lowercase", () => {
    expect(preprocessQuery("AUTHENTICATE")).toBe("authenticate");
    expect(preprocessQuery("How Do Users Authenticate")).toBe("how do users authenticate");
  });

  it("removes punctuation", () => {
    expect(preprocessQuery("authenticate?")).toBe("authenticate");
    expect(preprocessQuery("How do users authenticate?")).toBe("how do users authenticate");
    expect(preprocessQuery("user@auth.com")).toBe("user auth com");
    expect(preprocessQuery("function(x) => x + 1")).toBe("function x x 1");
  });

  it("normalizes whitespace", () => {
    expect(preprocessQuery("how  do  users  authenticate")).toBe("how do users authenticate");
    expect(preprocessQuery("  leading spaces")).toBe("leading spaces");
    expect(preprocessQuery("trailing spaces  ")).toBe("trailing spaces");
    expect(preprocessQuery("  multiple   spaces  ")).toBe("multiple spaces");
  });

  it("handles combined transformations", () => {
    expect(preprocessQuery("  How Do Users Authenticate?  ")).toBe("how do users authenticate");
    expect(preprocessQuery("What's the data-flow?")).toBe("what s the data flow");
    expect(preprocessQuery("API → Database (model)")).toBe("api database model");
  });

  it("preserves alphanumeric characters", () => {
    expect(preprocessQuery("find symbol123")).toBe("find symbol123");
    expect(preprocessQuery("version_2_0")).toBe("version_2_0");
  });

  it("handles empty and whitespace-only queries", () => {
    expect(preprocessQuery("")).toBe("");
    expect(preprocessQuery("   ")).toBe("");
    expect(preprocessQuery("\t\n")).toBe("");
  });

  it("handles special characters", () => {
    expect(preprocessQuery("user#123")).toBe("user 123");
    expect(preprocessQuery("path/to/file")).toBe("path to file");
    expect(preprocessQuery("key=value")).toBe("key value");
  });
});

describe("isValidQuery", () => {
  it("returns true for non-empty queries", () => {
    expect(isValidQuery("authenticate")).toBe(true);
    expect(isValidQuery("How do users authenticate?")).toBe(true);
    expect(isValidQuery("  query  ")).toBe(true);
  });

  it("returns false for empty queries", () => {
    expect(isValidQuery("")).toBe(false);
    expect(isValidQuery("   ")).toBe(false);
    expect(isValidQuery("\t\n")).toBe(false);
  });

  it("returns false for queries with only punctuation", () => {
    expect(isValidQuery("???")).toBe(false);
    expect(isValidQuery("!!!")).toBe(false);
    expect(isValidQuery("@#$%")).toBe(false);
  });
});
