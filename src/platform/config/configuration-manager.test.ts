import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ConfigurationManager } from "./configuration-manager.js";
import { PrefixValidationError, OllamaConfigError, EmbeddingConfigError, LadybugConfigError } from "./errors.js";

// Mock node:fs/promises to avoid real filesystem operations
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// Mock node:os to control homedir in tests
vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/mock-home"),
}));

import { mkdir } from "node:fs/promises";

const mockMkdir = mkdir as ReturnType<typeof vi.fn>;

describe("ConfigurationManager", () => {
  let manager: ConfigurationManager;
  const originalEnv = process.env;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env = { ...originalEnv };
    manager = new ConfigurationManager();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockMkdir.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  // ── Prefix defaults ──────────────────────────────────────────────────────

  it("defaults to tpc_ when TYPOCOP_PREFIX is not set", async () => {
    delete process.env["TYPOCOP_PREFIX"];
    await manager.initialize();
    expect(manager.getPrefix()).toBe("tpc_");
  });

  it("defaults to tpc_ when TYPOCOP_PREFIX is empty string", async () => {
    process.env["TYPOCOP_PREFIX"] = "";
    await manager.initialize();
    expect(manager.getPrefix()).toBe("tpc_");
  });

  it("reports source as default when env var is not set", async () => {
    delete process.env["TYPOCOP_PREFIX"];
    await manager.initialize();
    expect(manager.getConfiguration().source).toBe("default");
  });

  it("writes startup diagnostics to stderr instead of stdout", async () => {
    await manager.initialize();
    expect(console.log).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[typocop] prefix="),
    );
  });

  // ── Prefix env var reading and normalization ──────────────────────────────

  it("uses env var value when TYPOCOP_PREFIX is a valid prefix with underscore", async () => {
    process.env["TYPOCOP_PREFIX"] = "myapp_";
    await manager.initialize();
    expect(manager.getPrefix()).toBe("myapp_");
  });

  // ── Ollama config defaults (Req 5.1, 5.2, 5.3, 5.4) ─────────────────────

  describe("Ollama config defaults", () => {
    beforeEach(() => {
      delete process.env["OLLAMA_ENABLED"];
      delete process.env["OLLAMA_URL"];
      delete process.env["OLLAMA_MODEL"];
      delete process.env["OLLAMA_DIMENSIONS"];
    });

    it("defaults OLLAMA_ENABLED to false when unset", async () => {
      await manager.initialize();
      expect(manager.getConfiguration().ollama.enabled).toBe(false);
    });

    it("defaults OLLAMA_URL to http://localhost:11434 when unset", async () => {
      await manager.initialize();
      expect(manager.getConfiguration().ollama.url).toBe(
        "http://localhost:11434",
      );
    });

    it("defaults OLLAMA_MODEL to mxbai-embed-large when unset", async () => {
      await manager.initialize();
      expect(manager.getConfiguration().ollama.model).toBe(
        "mxbai-embed-large",
      );
    });

    it("defaults OLLAMA_DIMENSIONS to 1024 when unset", async () => {
      await manager.initialize();
      expect(manager.getConfiguration().ollama.dimensions).toBe(1024);
    });
  });

  // ── Ollama config from env vars ───────────────────────────────────────────

  describe("Ollama config from env vars", () => {
    it("enables embeddings when OLLAMA_ENABLED=true", async () => {
      process.env["OLLAMA_ENABLED"] = "true";
      await manager.initialize();
      expect(manager.getConfiguration().ollama.enabled).toBe(true);
    });

    it("enables embeddings when OLLAMA_ENABLED=TRUE (case-insensitive)", async () => {
      process.env["OLLAMA_ENABLED"] = "TRUE";
      await manager.initialize();
      expect(manager.getConfiguration().ollama.enabled).toBe(true);
    });

    it("keeps disabled when OLLAMA_ENABLED=false", async () => {
      process.env["OLLAMA_ENABLED"] = "false";
      await manager.initialize();
      expect(manager.getConfiguration().ollama.enabled).toBe(false);
    });

    it("overrides OLLAMA_URL from env var", async () => {
      process.env["OLLAMA_URL"] = "https://ollama.example.com:8080";
      await manager.initialize();
      expect(manager.getConfiguration().ollama.url).toBe(
        "https://ollama.example.com:8080",
      );
    });

    it("overrides OLLAMA_MODEL from env var", async () => {
      process.env["OLLAMA_MODEL"] = "nomic-embed-text";
      await manager.initialize();
      expect(manager.getConfiguration().ollama.model).toBe("nomic-embed-text");
    });

    it("overrides OLLAMA_DIMENSIONS from env var", async () => {
      process.env["OLLAMA_DIMENSIONS"] = "768";
      await manager.initialize();
      expect(manager.getConfiguration().ollama.dimensions).toBe(768);
    });
  });

  // ── Ollama validation (Req 5.4, 5.7) ─────────────────────────────────────

  describe("Ollama validation", () => {
    it("throws OllamaConfigError for non-http URL", async () => {
      process.env["OLLAMA_URL"] = "ftp://ollama.local";
      await expect(manager.initialize()).rejects.toThrow(OllamaConfigError);
    });

    it("throws OllamaConfigError for completely invalid URL", async () => {
      process.env["OLLAMA_URL"] = "not-a-url";
      await expect(manager.initialize()).rejects.toThrow(OllamaConfigError);
    });

    it("throws OllamaConfigError for non-integer dimensions", async () => {
      process.env["OLLAMA_DIMENSIONS"] = "3.14";
      await expect(manager.initialize()).rejects.toThrow(OllamaConfigError);
    });

    it("throws OllamaConfigError for zero dimensions", async () => {
      process.env["OLLAMA_DIMENSIONS"] = "0";
      await expect(manager.initialize()).rejects.toThrow(OllamaConfigError);
    });

    it("throws OllamaConfigError for negative dimensions", async () => {
      process.env["OLLAMA_DIMENSIONS"] = "-512";
      await expect(manager.initialize()).rejects.toThrow(OllamaConfigError);
    });

    it("throws OllamaConfigError for non-numeric dimensions", async () => {
      process.env["OLLAMA_DIMENSIONS"] = "abc";
      await expect(manager.initialize()).rejects.toThrow(OllamaConfigError);
    });

    it("accepts valid http URL", async () => {
      process.env["OLLAMA_URL"] = "http://192.168.1.100:11434";
      await manager.initialize();
      expect(manager.getConfiguration().ollama.url).toBe(
        "http://192.168.1.100:11434",
      );
    });

    it("accepts valid https URL", async () => {
      process.env["OLLAMA_URL"] = "https://ollama.example.com";
      await manager.initialize();
      expect(manager.getConfiguration().ollama.url).toBe(
        "https://ollama.example.com",
      );
    });
  });

  // ── LadybugDB config (Req 5.5, 5.6) ──────────────────────────────────────

  describe("LadybugDB config", () => {
    it("overrides default path when LADYBUGDB_PATH is set", async () => {
      process.env["LADYBUGDB_PATH"] = "/custom/path/db.ladybug";
      await manager.initialize();
      expect(manager.getConfiguration().ladybugdb.dbPath).toBe(
        "/custom/path/db.ladybug",
      );
    });

    it("uses default path ~/.typocop/{prefix}/db.ladybug when LADYBUGDB_PATH is unset", async () => {
      delete process.env["LADYBUGDB_PATH"];
      delete process.env["TYPOCOP_PREFIX"];
      await manager.initialize();
      const config = manager.getConfiguration();
      expect(config.ladybugdb.dbPath).toContain("/mock-home/");
      expect(config.ladybugdb.dbPath).toContain(".typocop");
      expect(config.ladybugdb.dbPath).toContain("tpc");
      expect(config.ladybugdb.dbPath.endsWith("db.ladybug")).toBe(true);
    });

    it("auto-creates database directory with recursive: true", async () => {
      delete process.env["LADYBUGDB_PATH"];
      await manager.initialize();
      expect(mockMkdir).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true },
      );
    });

    it("auto-creates directory for custom LADYBUGDB_PATH", async () => {
      process.env["LADYBUGDB_PATH"] = "/custom/deep/path/db.ladybug";
      await manager.initialize();
      expect(mockMkdir).toHaveBeenCalledWith("/custom/deep/path", {
        recursive: true,
      });
    });

    it("applies documented defaults for connection-server settings", async () => {
      delete process.env["LADYBUG_RUNTIME_MODE"];
      delete process.env["LADYBUG_SERVER_URL"];
      delete process.env["LADYBUG_SERVER_HOST"];
      delete process.env["LADYBUG_SERVER_PORT"];
      delete process.env["LADYBUG_SERVER_AUTH_TOKEN"];
      delete process.env["LADYBUG_SERVER_MAX_CONCURRENCY"];
      delete process.env["LADYBUG_SERVER_MAX_QUEUE"];
      delete process.env["LADYBUG_SERVER_AUTOSTART"];
      delete process.env["LADYBUG_SERVER_STARTUP_TIMEOUT_MS"];
      delete process.env["LADYBUG_SERVER_LOCK_PATH"];
      delete process.env["LADYBUG_SERVER_DISCOVERY_PATH"];
      delete process.env["LADYBUG_SERVER_IDLE_TTL_MS"];

      await manager.initialize();
      const config = manager.getConfiguration().ladybugdb;

      expect(config.runtimeMode).toBe("server");
      expect(config.serverUrl).toBe("grpc://127.0.0.1:7617");
      expect(config.serverHost).toBe("127.0.0.1");
      expect(config.serverPort).toBe(7617);
      expect(config.serverAuthToken).toBe("");
      expect(config.serverMaxConcurrency).toBe(4);
      expect(config.serverMaxQueue).toBe(256);
      expect(config.serverAutostart).toBe(false);
      expect(config.serverStartupTimeoutMs).toBe(10_000);
      expect(config.serverIdleTtlMs).toBe(0);
      expect(config.serverLockPath).toContain("/mock-home/.typocop/locks/");
      expect(config.serverLockPath).toContain("tpc_-ladybug-server.lock");
      expect(config.serverDiscoveryPath).toContain("/mock-home/.typocop/tpc_/");
      expect(config.serverDiscoveryPath.endsWith("ladybug-server.json")).toBe(true);
    });

    it("validates grpc urls in client mode", async () => {
      process.env["LADYBUG_RUNTIME_MODE"] = "client";
      process.env["LADYBUG_SERVER_URL"] = "http://127.0.0.1:7617";

      await expect(manager.initialize()).rejects.toThrow(LadybugConfigError);
    });

    it("rejects ports outside the valid grpc range", async () => {
      process.env["LADYBUG_SERVER_PORT"] = "70000";

      await expect(manager.initialize()).rejects.toThrow(LadybugConfigError);
    });

    it("rejects maxConcurrency below one", async () => {
      process.env["LADYBUG_SERVER_MAX_CONCURRENCY"] = "0";

      await expect(manager.initialize()).rejects.toThrow(LadybugConfigError);
    });

    it("rejects maxQueue below one", async () => {
      process.env["LADYBUG_SERVER_MAX_QUEUE"] = "0";

      await expect(manager.initialize()).rejects.toThrow(LadybugConfigError);
    });
  });

  // ── Embedding config defaults ─────────────────────────────────────────────

  describe("Embedding config defaults", () => {
    beforeEach(() => {
      delete process.env["EMBEDDING_PROVIDER"];
      delete process.env["HF_MODEL"];
      delete process.env["HF_DTYPE"];
      delete process.env["HF_DIMENSIONS"];
      delete process.env["HF_POOLING"];
      delete process.env["OLLAMA_ENABLED"];
    });

    it("defaults to provider huggingface, model mxbai-embed-large-v1, dtype fp32, dimensions 1024, pooling cls", async () => {
      await manager.initialize();
      const { embedding } = manager.getConfiguration();
      expect(embedding.provider).toBe("huggingface");
      expect(embedding.huggingface.model).toBe("mixedbread-ai/mxbai-embed-large-v1");
      expect(embedding.huggingface.dtype).toBe("fp32");
      expect(embedding.huggingface.dimensions).toBe(1024);
      expect(embedding.huggingface.pooling).toBe("cls");
    });
  });

  // ── Embedding provider env var parsing ────────────────────────────────────

  describe("Embedding provider env var parsing", () => {
    beforeEach(() => {
      delete process.env["EMBEDDING_PROVIDER"];
      delete process.env["OLLAMA_ENABLED"];
      delete process.env["HF_MODEL"];
      delete process.env["HF_DTYPE"];
      delete process.env["HF_DIMENSIONS"];
      delete process.env["HF_POOLING"];
    });

    it("EMBEDDING_PROVIDER=huggingface → provider is huggingface", async () => {
      process.env["EMBEDDING_PROVIDER"] = "huggingface";
      await manager.initialize();
      expect(manager.getConfiguration().embedding.provider).toBe("huggingface");
    });

    it("EMBEDDING_PROVIDER=ollama → provider is ollama", async () => {
      process.env["EMBEDDING_PROVIDER"] = "ollama";
      await manager.initialize();
      expect(manager.getConfiguration().embedding.provider).toBe("ollama");
    });

    it("EMBEDDING_PROVIDER=none → provider is none", async () => {
      process.env["EMBEDDING_PROVIDER"] = "none";
      await manager.initialize();
      expect(manager.getConfiguration().embedding.provider).toBe("none");
    });
  });

  // ── HuggingFace config env var parsing ────────────────────────────────────

  describe("HuggingFace config env var parsing", () => {
    beforeEach(() => {
      delete process.env["EMBEDDING_PROVIDER"];
      delete process.env["OLLAMA_ENABLED"];
      delete process.env["HF_MODEL"];
      delete process.env["HF_DTYPE"];
      delete process.env["HF_DIMENSIONS"];
      delete process.env["HF_POOLING"];
    });

    it("HF_MODEL=custom-model → model is custom-model", async () => {
      process.env["HF_MODEL"] = "custom-model";
      await manager.initialize();
      expect(manager.getConfiguration().embedding.huggingface.model).toBe("custom-model");
    });

    it("HF_DTYPE=fp16 → dtype is fp16", async () => {
      process.env["HF_DTYPE"] = "fp16";
      await manager.initialize();
      expect(manager.getConfiguration().embedding.huggingface.dtype).toBe("fp16");
    });

    it("HF_DTYPE=q8 → dtype is q8", async () => {
      process.env["HF_DTYPE"] = "q8";
      await manager.initialize();
      expect(manager.getConfiguration().embedding.huggingface.dtype).toBe("q8");
    });

    it("HF_DIMENSIONS=512 → dimensions is 512", async () => {
      process.env["HF_DIMENSIONS"] = "512";
      await manager.initialize();
      expect(manager.getConfiguration().embedding.huggingface.dimensions).toBe(512);
    });

    it("HF_POOLING=mean → pooling is mean", async () => {
      process.env["HF_POOLING"] = "mean";
      await manager.initialize();
      expect(manager.getConfiguration().embedding.huggingface.pooling).toBe("mean");
    });
  });

  // ── Backward compatibility (Req 5.1, 5.2, 5.3) ──────────────────────────

  describe("Backward compatibility (Req 5.1, 5.2, 5.3)", () => {
    beforeEach(() => {
      delete process.env["EMBEDDING_PROVIDER"];
      delete process.env["OLLAMA_ENABLED"];
      delete process.env["HF_MODEL"];
      delete process.env["HF_DTYPE"];
      delete process.env["HF_DIMENSIONS"];
      delete process.env["HF_POOLING"];
    });

    it("OLLAMA_ENABLED=true without EMBEDDING_PROVIDER → provider defaults to ollama", async () => {
      process.env["OLLAMA_ENABLED"] = "true";
      await manager.initialize();
      expect(manager.getConfiguration().embedding.provider).toBe("ollama");
    });

    it("OLLAMA_ENABLED=false without EMBEDDING_PROVIDER → provider defaults to huggingface", async () => {
      process.env["OLLAMA_ENABLED"] = "false";
      await manager.initialize();
      expect(manager.getConfiguration().embedding.provider).toBe("huggingface");
    });

    it("OLLAMA_ENABLED unset without EMBEDDING_PROVIDER → provider defaults to huggingface", async () => {
      await manager.initialize();
      expect(manager.getConfiguration().embedding.provider).toBe("huggingface");
    });

    it("EMBEDDING_PROVIDER=none overrides OLLAMA_ENABLED=true", async () => {
      process.env["EMBEDDING_PROVIDER"] = "none";
      process.env["OLLAMA_ENABLED"] = "true";
      await manager.initialize();
      expect(manager.getConfiguration().embedding.provider).toBe("none");
    });
  });

  // ── Embedding validation errors ───────────────────────────────────────────

  describe("Embedding validation errors", () => {
    beforeEach(() => {
      delete process.env["EMBEDDING_PROVIDER"];
      delete process.env["OLLAMA_ENABLED"];
      delete process.env["HF_MODEL"];
      delete process.env["HF_DTYPE"];
      delete process.env["HF_DIMENSIONS"];
      delete process.env["HF_POOLING"];
    });

    it("throws EmbeddingConfigError for invalid provider", async () => {
      process.env["EMBEDDING_PROVIDER"] = "invalid";
      await expect(manager.initialize()).rejects.toThrow(EmbeddingConfigError);
    });

    it("throws EmbeddingConfigError for HF_DTYPE=bf16", async () => {
      process.env["HF_DTYPE"] = "bf16";
      await expect(manager.initialize()).rejects.toThrow(EmbeddingConfigError);
    });

    it("throws EmbeddingConfigError for HF_DTYPE=invalid", async () => {
      process.env["HF_DTYPE"] = "invalid";
      await expect(manager.initialize()).rejects.toThrow(EmbeddingConfigError);
    });

    it("throws EmbeddingConfigError for HF_DIMENSIONS=0", async () => {
      process.env["HF_DIMENSIONS"] = "0";
      await expect(manager.initialize()).rejects.toThrow(EmbeddingConfigError);
    });

    it("throws EmbeddingConfigError for HF_DIMENSIONS=-1", async () => {
      process.env["HF_DIMENSIONS"] = "-1";
      await expect(manager.initialize()).rejects.toThrow(EmbeddingConfigError);
    });

    it("throws EmbeddingConfigError for HF_DIMENSIONS=3.14", async () => {
      process.env["HF_DIMENSIONS"] = "3.14";
      await expect(manager.initialize()).rejects.toThrow(EmbeddingConfigError);
    });

    it("throws EmbeddingConfigError for HF_DIMENSIONS=abc", async () => {
      process.env["HF_DIMENSIONS"] = "abc";
      await expect(manager.initialize()).rejects.toThrow(EmbeddingConfigError);
    });
  });
});
