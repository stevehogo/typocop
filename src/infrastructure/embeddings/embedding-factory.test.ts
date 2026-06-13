/**
 * Provider-based embedding-adapter selection (Req 6.1–6.4).
 *
 * This coverage moved here from database-adapter.test.ts when the provider
 * switch was lifted out of the DB adapter into createEmbeddingAdapter (§14).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EmbeddingConfig, OllamaConfig } from "../../platform/config/types.js";

vi.mock("./ollama-embedding-adapter.js", () => ({
  OllamaEmbeddingAdapter: vi.fn(function (this: Record<string, unknown>) {
    this.__type = "ollama-embedding"; this.isEnabled = () => true;
  }),
}));
vi.mock("./noop-embedding-adapter.js", () => ({
  NoOpEmbeddingAdapter: vi.fn(function (this: Record<string, unknown>) {
    this.__type = "noop-embedding"; this.isEnabled = () => false;
  }),
}));
vi.mock("./huggingface-embedding-adapter.js", () => ({
  HuggingFaceEmbeddingAdapter: vi.fn(function (this: Record<string, unknown>) {
    this.__type = "huggingface-embedding"; this.isEnabled = () => true;
  }),
}));

import { OllamaEmbeddingAdapter } from "./ollama-embedding-adapter.js";
import { NoOpEmbeddingAdapter } from "./noop-embedding-adapter.js";
import { HuggingFaceEmbeddingAdapter } from "./huggingface-embedding-adapter.js";
import { createEmbeddingAdapter } from "./embedding-factory.js";

const MockedOllamaAdapter = vi.mocked(OllamaEmbeddingAdapter);
const MockedNoOpAdapter = vi.mocked(NoOpEmbeddingAdapter);
const MockedHFAdapter = vi.mocked(HuggingFaceEmbeddingAdapter);

const HF_DEFAULTS = { model: "mixedbread-ai/mxbai-embed-large-v1", dtype: "fp32" as const, dimensions: 1024, pooling: "cls" as const };
const ollamaCfg: OllamaConfig = { enabled: true, url: "http://localhost:11434", model: "mxbai-embed-large", dimensions: 1024 };
const embeddingCfg = (provider: EmbeddingConfig["provider"]): EmbeddingConfig => ({ provider, huggingface: HF_DEFAULTS });

describe("createEmbeddingAdapter (Req 6.1-6.4)", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("creates HuggingFaceEmbeddingAdapter when provider is 'huggingface'", () => {
    const adapter = createEmbeddingAdapter(embeddingCfg("huggingface"), ollamaCfg);
    expect(MockedHFAdapter).toHaveBeenCalledWith(HF_DEFAULTS);
    expect((adapter as unknown as Record<string, unknown>).__type).toBe("huggingface-embedding");
  });

  it("creates OllamaEmbeddingAdapter when provider is 'ollama'", () => {
    const adapter = createEmbeddingAdapter(embeddingCfg("ollama"), ollamaCfg);
    expect(MockedOllamaAdapter).toHaveBeenCalledWith(ollamaCfg);
    expect((adapter as unknown as Record<string, unknown>).__type).toBe("ollama-embedding");
  });

  it("creates NoOpEmbeddingAdapter when provider is 'none'", () => {
    const adapter = createEmbeddingAdapter(embeddingCfg("none"), ollamaCfg);
    expect(MockedNoOpAdapter).toHaveBeenCalled();
    expect((adapter as unknown as Record<string, unknown>).__type).toBe("noop-embedding");
  });

  it("instantiates exactly one adapter type per provider", () => {
    for (const provider of ["huggingface", "ollama", "none"] as const) {
      vi.clearAllMocks();
      createEmbeddingAdapter(embeddingCfg(provider), ollamaCfg);
      const counts = [
        MockedHFAdapter.mock.calls.length,
        MockedOllamaAdapter.mock.calls.length,
        MockedNoOpAdapter.mock.calls.length,
      ];
      expect(counts.filter((c) => c === 1)).toHaveLength(1);
      expect(counts.filter((c) => c === 0)).toHaveLength(2);
    }
  });
});
