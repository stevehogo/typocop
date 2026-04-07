import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ConfigurationManager } from "./configuration-manager.js";
import { PrefixValidationError } from "./errors.js";

describe("ConfigurationManager", () => {
  let manager: ConfigurationManager;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    manager = new ConfigurationManager();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  // ── 2.2 Default resolution ────────────────────────────────────────────────

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

  // ── 2.1 / 2.3 Env var reading and normalization ───────────────────────────

  it("uses env var value when TYPOCOP_PREFIX is a valid prefix with underscore", async () => {
    process.env["TYPOCOP_PREFIX"] = "myapp_";
    await manager.initialize();
    expect(manager.getPrefix()).toBe("myapp_");
  });

  it("normalizes prefix without trailing underscore (tpc → tpc_)", async () => {
    process.env["TYPOCOP_PREFIX"] = "tpc";
    await manager.initialize();
    expect(manager.getPrefix()).toBe("tpc_");
  });

  it("reports source as environment when env var is set", async () => {
    process.env["TYPOCOP_PREFIX"] = "myapp_";
    await manager.initialize();
    expect(manager.getConfiguration().source).toBe("environment");
  });

  // ── 2.3 Invalid prefix throws ConfigurationError ─────────────────────────

  it("throws PrefixValidationError for uppercase prefix", async () => {
    process.env["TYPOCOP_PREFIX"] = "MyApp";
    await expect(manager.initialize()).rejects.toBeInstanceOf(PrefixValidationError);
  });

  it("throws PrefixValidationError for prefix with special characters", async () => {
    process.env["TYPOCOP_PREFIX"] = "my-app";
    await expect(manager.initialize()).rejects.toBeInstanceOf(PrefixValidationError);
  });

  it("thrown error includes the invalid prefix value", async () => {
    process.env["TYPOCOP_PREFIX"] = "BAD";
    const err = await manager.initialize().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrefixValidationError);
    expect((err as PrefixValidationError).prefix).toBe("BAD");
  });

  it("thrown error includes a reason string", async () => {
    process.env["TYPOCOP_PREFIX"] = "MyApp";
    const err = await manager.initialize().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrefixValidationError);
    expect((err as PrefixValidationError).reason).toBeTruthy();
  });

  it("thrown error includes a suggestion for uppercase prefix", async () => {
    process.env["TYPOCOP_PREFIX"] = "MyApp";
    const err = await manager.initialize().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrefixValidationError);
    expect((err as PrefixValidationError).suggestion).toBe("myapp");
  });

  it("thrown error is a ConfigurationError (base class check)", async () => {
    const { ConfigurationError } = await import("./errors.js");
    process.env["TYPOCOP_PREFIX"] = "BAD!";
    const err = await manager.initialize().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigurationError);
  });

  // ── 2.1 getPrefix() throws before initialize() ───────────────────────────

  it("getPrefix() throws if initialize() has not been called", () => {
    expect(() => manager.getPrefix()).toThrow(
      "ConfigurationManager has not been initialized",
    );
  });

  it("getConfiguration() throws if initialize() has not been called", () => {
    expect(() => manager.getConfiguration()).toThrow(
      "ConfigurationManager has not been initialized",
    );
  });

  // ── getConfiguration() shape ─────────────────────────────────────────────

  it("getConfiguration() returns a Date for loadedAt", async () => {
    delete process.env["TYPOCOP_PREFIX"];
    await manager.initialize();
    expect(manager.getConfiguration().loadedAt).toBeInstanceOf(Date);
  });

  // ── validate() delegates to PrefixValidator ───────────────────────────────

  it("validate() returns valid result for a good prefix", () => {
    const result = manager.validate("myapp_");
    expect(result.valid).toBe(true);
  });

  it("validate() returns invalid result for an uppercase prefix", () => {
    const result = manager.validate("MyApp");
    expect(result.valid).toBe(false);
  });
});
