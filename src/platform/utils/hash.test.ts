import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { sha256Hex } from "./hash.js";

describe("sha256Hex", () => {
  it("returns the hex sha256 digest of a UTF-8 string", () => {
    const expected = createHash("sha256").update("hello world", "utf8").digest("hex");
    expect(sha256Hex("hello world")).toBe(expected);
  });

  it("is deterministic — identical input yields identical digest", () => {
    expect(sha256Hex("const x = 1;")).toBe(sha256Hex("const x = 1;"));
  });

  it("is sensitive to content — a one-char edit changes the digest", () => {
    expect(sha256Hex("const x = 1;")).not.toBe(sha256Hex("const x = 2;"));
  });

  it("hashes the empty string to the canonical sha256 empty digest", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("is a 64-char lowercase hex string", () => {
    expect(sha256Hex("anything")).toMatch(/^[0-9a-f]{64}$/);
  });
});
