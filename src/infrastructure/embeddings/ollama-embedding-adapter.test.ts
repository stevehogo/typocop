/**
 * Unit tests for OllamaEmbeddingAdapter.
 * Requirements: 4.1, 4.2, 4.3, 4.6
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OllamaEmbeddingAdapter } from "./ollama-embedding-adapter.js";
import type { OllamaConfig } from "../../platform/config/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<OllamaConfig>): OllamaConfig {
  return {
    enabled: true,
    url: "http://localhost:11434",
    model: "qwen3-embedding:4b",
    dimensions: 4,
    ...overrides,
  };
}

function ollamaResponse(embedding: number[], model = "qwen3-embedding:4b"): Response {
  return new Response(JSON.stringify({ embedding, model }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("OllamaEmbeddingAdapter", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── isEnabled ──────────────────────────────────────────────────────────

  describe("isEnabled", () => {
    it("should return true", () => {
      const adapter = new OllamaEmbeddingAdapter(makeConfig());
      expect(adapter.isEnabled()).toBe(true);
    });
  });

  // ── getDimensions ──────────────────────────────────────────────────────

  describe("getDimensions", () => {
    it("should return configured dimensions", () => {
      const adapter = new OllamaEmbeddingAdapter(makeConfig({ dimensions: 2560 }));
      expect(adapter.getDimensions()).toBe(2560);
    });
  });

  // ── embedText — success (Req 4.1, 4.2) ────────────────────────────────

  describe("embedText — success", () => {
    it("should call POST {url}/api/embeddings with model and prompt (Req 4.1)", async () => {
      const config = makeConfig();
      const adapter = new OllamaEmbeddingAdapter(config);
      fetchSpy.mockResolvedValueOnce(ollamaResponse([0.1, 0.2, 0.3, 0.4]));

      await adapter.embedText("myFunction class method");

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("http://localhost:11434/api/embeddings");
      expect(init).toMatchObject({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const body = JSON.parse(init!.body as string);
      expect(body).toEqual({ model: "qwen3-embedding:4b", prompt: "myFunction class method" });
    });

    it("should return Embedding with correct vector and dimensions (Req 4.2)", async () => {
      const adapter = new OllamaEmbeddingAdapter(makeConfig({ dimensions: 4 }));
      fetchSpy.mockResolvedValueOnce(ollamaResponse([0.1, 0.2, 0.3, 0.4]));

      const result = await adapter.embedText("symbol metadata");

      expect(result).not.toBeNull();
      expect(result!.vector).toEqual([0.1, 0.2, 0.3, 0.4]);
      expect(result!.dimensions).toBe(4);
    });
  });

  // ── embedText — unreachable (Req 4.3) ──────────────────────────────────

  describe("embedText — unreachable", () => {
    it("should return null when fetch throws (Req 4.3)", async () => {
      const adapter = new OllamaEmbeddingAdapter(makeConfig());
      fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));

      const result = await adapter.embedText("symbol metadata");

      expect(result).toBeNull();
    });

    it("should return null on non-OK HTTP response", async () => {
      const adapter = new OllamaEmbeddingAdapter(makeConfig());
      fetchSpy.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

      const result = await adapter.embedText("symbol metadata");

      expect(result).toBeNull();
    });
  });

  // ── embedText — dimension mismatch (Req 4.2) ──────────────────────────

  describe("embedText — dimension mismatch", () => {
    it("should return null when response dimensions differ from config (Req 4.2)", async () => {
      const adapter = new OllamaEmbeddingAdapter(makeConfig({ dimensions: 4 }));
      // Ollama returns 3 dimensions instead of expected 4
      fetchSpy.mockResolvedValueOnce(ollamaResponse([0.1, 0.2, 0.3]));

      const result = await adapter.embedText("symbol metadata");

      expect(result).toBeNull();
    });
  });

  // ── embedText — privacy check (Req 4.6) ───────────────────────────────

  describe("embedText — privacy check", () => {
    it("should throw when text contains source code (Req 4.6)", async () => {
      const adapter = new OllamaEmbeddingAdapter(makeConfig());
      const sourceCode = `function doStuff(x: number) {\n  return x + 1;\n  const y = x * 2;\n}`;

      await expect(adapter.embedText(sourceCode)).rejects.toThrow("Privacy violation");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("should allow symbol metadata text (Req 4.6)", async () => {
      const adapter = new OllamaEmbeddingAdapter(makeConfig());
      fetchSpy.mockResolvedValueOnce(ollamaResponse([0.1, 0.2, 0.3, 0.4]));

      const result = await adapter.embedText("myFunction method public async");

      expect(result).not.toBeNull();
    });
  });
});
