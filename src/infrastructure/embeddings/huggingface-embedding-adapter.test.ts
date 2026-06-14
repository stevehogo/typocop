/**
 * Unit tests for HuggingFaceEmbeddingAdapter.
 * Requirements: 1.1–1.6, 2.3, 3.1, 3.2, 7.1, 7.2
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HuggingFaceConfig } from "../../platform/config/types.js";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockDispose = vi.fn();
const mockExtractor = Object.assign(
  vi.fn().mockResolvedValue({ tolist: () => [[0.1, 0.2, 0.3, 0.4]] }),
  { dispose: mockDispose },
);

const mockPipeline = vi.fn().mockResolvedValue(mockExtractor);

vi.mock("@huggingface/transformers", () => ({
  pipeline: (...args: unknown[]) => mockPipeline(...args),
}));

vi.mock("../../platform/security/privacy.js", () => ({
  verifyEmbeddingText: vi.fn(),
}));

import { HuggingFaceEmbeddingAdapter } from "./huggingface-embedding-adapter.js";
import { verifyEmbeddingText } from "../../platform/security/privacy.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<HuggingFaceConfig>): HuggingFaceConfig {
  return {
    model: "mixedbread-ai/mxbai-embed-large-v1",
    dtype: "fp32",
    dimensions: 4,
    pooling: "cls",
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("HuggingFaceEmbeddingAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks resets call history but NOT implementations set via
    // mockImplementation, so explicitly restore the no-op privacy gate.
    vi.mocked(verifyEmbeddingText).mockReset();
    mockExtractor.mockResolvedValue({ tolist: () => [[0.1, 0.2, 0.3, 0.4]] });
    mockPipeline.mockResolvedValue(mockExtractor);
  });

  // ── isEnabled (Req 1.2) ────────────────────────────────────────────────

  describe("isEnabled", () => {
    it("should return true", () => {
      const adapter = new HuggingFaceEmbeddingAdapter(makeConfig());
      expect(adapter.isEnabled()).toBe(true);
    });
  });

  // ── getDimensions (Req 1.3) ────────────────────────────────────────────

  describe("getDimensions", () => {
    it("should return config.dimensions", () => {
      const adapter = new HuggingFaceEmbeddingAdapter(makeConfig({ dimensions: 1024 }));
      expect(adapter.getDimensions()).toBe(1024);
    });
  });

  // ── embedText — success (Req 1.4) ─────────────────────────────────────

  describe("embedText — success", () => {
    it("should return Embedding with correct vector and dimensions", async () => {
      const adapter = new HuggingFaceEmbeddingAdapter(makeConfig());

      const result = await adapter.embedText("symbol metadata");

      expect(result).not.toBeNull();
      expect(result!.vector).toEqual([0.1, 0.2, 0.3, 0.4]);
      expect(result!.dimensions).toBe(4);
    });
  });

  // ── embedText — error (Req 1.6) ───────────────────────────────────────

  describe("embedText — error", () => {
    it("should return null when pipeline throws", async () => {
      mockPipeline.mockRejectedValueOnce(new Error("ONNX crash"));
      const adapter = new HuggingFaceEmbeddingAdapter(makeConfig());

      const result = await adapter.embedText("symbol metadata");

      expect(result).toBeNull();
    });
  });

  // ── embedText — dimension mismatch (Req 1.5) ─────────────────────────

  describe("embedText — dimension mismatch", () => {
    it("should return null when output dimensions differ from config", async () => {
      mockExtractor.mockResolvedValueOnce({ tolist: () => [[0.1, 0.2]] });
      const adapter = new HuggingFaceEmbeddingAdapter(makeConfig({ dimensions: 4 }));

      const result = await adapter.embedText("symbol metadata");

      expect(result).toBeNull();
    });
  });

  // ── embedText — privacy (Req 3.1, 3.2) ────────────────────────────────

  describe("embedText — privacy", () => {
    it("should call verifyEmbeddingText before pipeline inference", async () => {
      const adapter = new HuggingFaceEmbeddingAdapter(makeConfig());

      await adapter.embedText("symbol metadata");

      expect(verifyEmbeddingText).toHaveBeenCalledWith("symbol metadata", "huggingface-embedding");
      expect(verifyEmbeddingText).toHaveBeenCalledBefore(mockExtractor);
    });

    it("should propagate privacy exceptions (not caught)", async () => {
      vi.mocked(verifyEmbeddingText).mockImplementationOnce(() => {
        throw new Error("Privacy violation");
      });
      const adapter = new HuggingFaceEmbeddingAdapter(makeConfig());

      await expect(adapter.embedText("source code")).rejects.toThrow("Privacy violation");
      expect(mockExtractor).not.toHaveBeenCalled();
    });
  });

  // ── concurrent init (Req 2.3) ─────────────────────────────────────────

  describe("concurrent initialization", () => {
    it("should call pipeline factory exactly once for concurrent calls", async () => {
      const adapter = new HuggingFaceEmbeddingAdapter(makeConfig());

      await Promise.all([
        adapter.embedText("text a"),
        adapter.embedText("text b"),
        adapter.embedText("text c"),
      ]);

      expect(mockPipeline).toHaveBeenCalledOnce();
    });
  });

  // ── embedTexts — batch fast-path (Phase 1) ────────────────────────────

  describe("embedTexts", () => {
    it("returns one index-aligned embedding per input from a single forward pass", async () => {
      mockExtractor.mockResolvedValueOnce({
        tolist: () => [
          [0.1, 0.2, 0.3, 0.4],
          [0.5, 0.6, 0.7, 0.8],
        ],
      });
      const adapter = new HuggingFaceEmbeddingAdapter(makeConfig());

      const results = await adapter.embedTexts(["alpha", "bravo"]);

      // single forward pass over the array
      expect(mockExtractor).toHaveBeenCalledTimes(1);
      expect(mockExtractor).toHaveBeenCalledWith(["alpha", "bravo"], { pooling: "cls" });
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ vector: [0.1, 0.2, 0.3, 0.4], dimensions: 4 });
      expect(results[1]).toEqual({ vector: [0.5, 0.6, 0.7, 0.8], dimensions: 4 });
    });

    it("runs verifyEmbeddingText on every text before inference", async () => {
      mockExtractor.mockResolvedValueOnce({
        tolist: () => [
          [0.1, 0.2, 0.3, 0.4],
          [0.5, 0.6, 0.7, 0.8],
        ],
      });
      const adapter = new HuggingFaceEmbeddingAdapter(makeConfig());

      await adapter.embedTexts(["alpha", "bravo"]);

      expect(verifyEmbeddingText).toHaveBeenCalledWith("alpha", "huggingface-embedding");
      expect(verifyEmbeddingText).toHaveBeenCalledWith("bravo", "huggingface-embedding");
    });

    it("marks a privacy-failing item null up front WITHOUT sending it into the batch", async () => {
      // Second text fails the privacy gate; only the first is embedded.
      vi.mocked(verifyEmbeddingText).mockImplementation((text: string) => {
        if (text === "secret") throw new Error("Privacy violation");
      });
      mockExtractor.mockResolvedValueOnce({ tolist: () => [[0.1, 0.2, 0.3, 0.4]] });
      const adapter = new HuggingFaceEmbeddingAdapter(makeConfig());

      const results = await adapter.embedTexts(["ok", "secret"]);

      // Only the valid text went into the batch.
      expect(mockExtractor).toHaveBeenCalledWith(["ok"], { pooling: "cls" });
      expect(results[0]).toEqual({ vector: [0.1, 0.2, 0.3, 0.4], dimensions: 4 });
      expect(results[1]).toBeNull();
    });

    it("marks an empty-string item null up front", async () => {
      mockExtractor.mockResolvedValueOnce({ tolist: () => [[0.1, 0.2, 0.3, 0.4]] });
      const adapter = new HuggingFaceEmbeddingAdapter(makeConfig());

      const results = await adapter.embedTexts(["", "valid"]);

      expect(mockExtractor).toHaveBeenCalledWith(["valid"], { pooling: "cls" });
      expect(results[0]).toBeNull();
      expect(results[1]).toEqual({ vector: [0.1, 0.2, 0.3, 0.4], dimensions: 4 });
    });

    it("returns all-null without calling inference when every item is invalid", async () => {
      vi.mocked(verifyEmbeddingText).mockImplementation(() => {
        throw new Error("Privacy violation");
      });
      const adapter = new HuggingFaceEmbeddingAdapter(makeConfig());

      const results = await adapter.embedTexts(["a", "b"]);

      expect(results).toEqual([null, null]);
      expect(mockExtractor).not.toHaveBeenCalled();
    });

    it("nulls a row whose dimensions differ from config", async () => {
      mockExtractor.mockResolvedValueOnce({
        tolist: () => [
          [0.1, 0.2, 0.3, 0.4],
          [0.5, 0.6], // wrong dimensions
        ],
      });
      const adapter = new HuggingFaceEmbeddingAdapter(makeConfig({ dimensions: 4 }));

      const results = await adapter.embedTexts(["alpha", "bravo"]);

      expect(results[0]).toEqual({ vector: [0.1, 0.2, 0.3, 0.4], dimensions: 4 });
      expect(results[1]).toBeNull();
    });

    it("rejects the whole call when inference throws (all-or-nothing)", async () => {
      mockExtractor.mockRejectedValueOnce(new Error("OOM"));
      const adapter = new HuggingFaceEmbeddingAdapter(makeConfig());

      await expect(adapter.embedTexts(["alpha", "bravo"])).rejects.toThrow("OOM");
    });
  });

  // ── dispose (Req 7.1, 7.2) ────────────────────────────────────────────

  describe("dispose", () => {
    it("should call dispose on the pipeline", async () => {
      const adapter = new HuggingFaceEmbeddingAdapter(makeConfig());
      await adapter.embedText("init pipeline");

      await adapter.dispose();

      expect(mockDispose).toHaveBeenCalledOnce();
    });

    it("should be safe to call before pipeline was initialized", async () => {
      const adapter = new HuggingFaceEmbeddingAdapter(makeConfig());

      await expect(adapter.dispose()).resolves.toBeUndefined();
      expect(mockDispose).not.toHaveBeenCalled();
    });

    it("should re-initialize pipeline on next embedText after dispose", async () => {
      const adapter = new HuggingFaceEmbeddingAdapter(makeConfig());
      await adapter.embedText("first call");
      expect(mockPipeline).toHaveBeenCalledOnce();

      await adapter.dispose();
      await adapter.embedText("after dispose");

      expect(mockPipeline).toHaveBeenCalledTimes(2);
    });
  });
});
