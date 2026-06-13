/**
 * Unit tests for NoOpEmbeddingAdapter.
 * Requirements: 4.4, 4.5
 */

import { describe, it, expect } from "vitest";
import { NoOpEmbeddingAdapter } from "./noop-embedding-adapter.js";

describe("NoOpEmbeddingAdapter", () => {
  // ── isEnabled (Req 4.4) ────────────────────────────────────────────────

  describe("isEnabled", () => {
    it("should return false (Req 4.4)", () => {
      const adapter = new NoOpEmbeddingAdapter();
      expect(adapter.isEnabled()).toBe(false);
    });
  });

  // ── getDimensions (Req 4.5) ────────────────────────────────────────────

  describe("getDimensions", () => {
    it("should return 0 (Req 4.5)", () => {
      const adapter = new NoOpEmbeddingAdapter();
      expect(adapter.getDimensions()).toBe(0);
    });
  });

  // ── embedText (Req 4.4) ────────────────────────────────────────────────

  describe("embedText", () => {
    it("should return null (Req 4.4)", async () => {
      const adapter = new NoOpEmbeddingAdapter();
      const result = await adapter.embedText("any text");
      expect(result).toBeNull();
    });

    it("should return null for empty string", async () => {
      const adapter = new NoOpEmbeddingAdapter();
      const result = await adapter.embedText("");
      expect(result).toBeNull();
    });
  });
});
