import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installProcessSafetyNet, type CrashRecord } from "./safety-net.js";

/**
 * A fake process surface: an EventEmitter that also tracks the listeners added
 * per event so we can assert the disposer removes exactly what it added. Using a
 * real EventEmitter + a spy `exit` means we can emit lifecycle events and assert
 * cleanup + exit code with ZERO real process death.
 */
class FakeProcess extends EventEmitter {}

describe("installProcessSafetyNet", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs async cleanup then exits non-zero on uncaughtException", async () => {
    const proc = new FakeProcess();
    const exit = vi.fn();
    const cleanupSync = vi.fn();
    const cleanupAsync = vi.fn().mockResolvedValue(undefined);

    installProcessSafetyNet({
      proc: proc as never,
      exit,
      cleanupSync,
      cleanupAsync,
    });

    proc.emit("uncaughtException", new Error("boom"));
    await new Promise((r) => setImmediate(r));

    expect(cleanupAsync).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("runs async cleanup then exits non-zero on unhandledRejection", async () => {
    const proc = new FakeProcess();
    const exit = vi.fn();
    const cleanupAsync = vi.fn().mockResolvedValue(undefined);

    installProcessSafetyNet({
      proc: proc as never,
      exit,
      cleanupSync: vi.fn(),
      cleanupAsync,
    });

    proc.emit("unhandledRejection", new Error("rejected"));
    await new Promise((r) => setImmediate(r));

    expect(cleanupAsync).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("still exits non-zero when async cleanup rejects", async () => {
    const proc = new FakeProcess();
    const exit = vi.fn();
    const cleanupAsync = vi.fn().mockRejectedValue(new Error("cleanup failed"));

    installProcessSafetyNet({
      proc: proc as never,
      exit,
      cleanupSync: vi.fn(),
      cleanupAsync,
    });

    proc.emit("uncaughtException", new Error("boom"));
    await new Promise((r) => setImmediate(r));

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("runs ONLY sync cleanup on exit (never exit() or async cleanup)", () => {
    const proc = new FakeProcess();
    const exit = vi.fn();
    const cleanupSync = vi.fn();
    const cleanupAsync = vi.fn().mockResolvedValue(undefined);

    installProcessSafetyNet({
      proc: proc as never,
      exit,
      cleanupSync,
      cleanupAsync,
    });

    proc.emit("exit", 0);

    expect(cleanupSync).toHaveBeenCalledTimes(1);
    expect(cleanupAsync).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("a shared cleanedUp guard prevents double cleanup across paths", async () => {
    const proc = new FakeProcess();
    const exit = vi.fn();

    // Simulate the server's single cleanedUp flag shared by sync + async paths.
    let cleanedUp = false;
    const cleanupSync = vi.fn(() => {
      if (cleanedUp) return;
      cleanedUp = true;
    });
    const cleanupAsync = vi.fn(async () => {
      if (cleanedUp) return;
      cleanedUp = true;
    });

    installProcessSafetyNet({
      proc: proc as never,
      exit,
      cleanupSync,
      cleanupAsync,
    });

    // Fatal path runs async cleanup (sets the flag) ...
    proc.emit("uncaughtException", new Error("boom"));
    await new Promise((r) => setImmediate(r));
    // ... then the exit handler runs sync cleanup, which must no-op.
    proc.emit("exit", 1);

    expect(cleanupAsync).toHaveBeenCalledTimes(1);
    expect(cleanupSync).toHaveBeenCalledTimes(1);
    expect(cleanedUp).toBe(true);
  });

  it("emits exactly one fatal_exit with reason + diagnostics on uncaughtException", async () => {
    const proc = new FakeProcess();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const getDiagnostics = vi.fn(() => ({ uptimeMs: 1234, inFlight: 3, queued: 5 }));

    installProcessSafetyNet({
      proc: proc as never,
      exit: vi.fn(),
      cleanupSync: vi.fn(),
      cleanupAsync: vi.fn().mockResolvedValue(undefined),
      getDiagnostics,
    });

    proc.emit("uncaughtException", new Error("boom"));
    await new Promise((r) => setImmediate(r));

    const fatalLines = errorSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .filter((entry) => entry["event"] === "fatal_exit");
    expect(fatalLines).toHaveLength(1);
    expect(fatalLines[0]).toMatchObject({
      event: "fatal_exit",
      reason: "uncaughtException",
      uptimeMs: 1234,
      inFlight: 3,
      queued: 5,
    });
  });

  it("does not double-emit fatal_exit across fatal then exit paths", async () => {
    const proc = new FakeProcess();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    installProcessSafetyNet({
      proc: proc as never,
      exit: vi.fn(),
      cleanupSync: vi.fn(),
      cleanupAsync: vi.fn().mockResolvedValue(undefined),
      getDiagnostics: () => ({ uptimeMs: 1, inFlight: 0, queued: 0 }),
    });

    proc.emit("uncaughtException", new Error("boom"));
    await new Promise((r) => setImmediate(r));
    // A non-zero exit afterwards must NOT produce a second fatal record.
    proc.emit("exit", 1);

    const fatalLines = errorSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .filter((entry) => entry["event"] === "fatal_exit");
    expect(fatalLines).toHaveLength(1);
  });

  it("emits fatal_exit on a non-zero exit when no prior fatal handler fired", () => {
    const proc = new FakeProcess();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    installProcessSafetyNet({
      proc: proc as never,
      exit: vi.fn(),
      cleanupSync: vi.fn(),
      getDiagnostics: () => ({ uptimeMs: 7, inFlight: 0, queued: 0 }),
    });

    proc.emit("exit", 1);

    const fatalLines = errorSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .filter((entry) => entry["event"] === "fatal_exit");
    expect(fatalLines).toHaveLength(1);
    expect(fatalLines[0]).toMatchObject({ reason: "exit", uptimeMs: 7 });
  });

  it("does not emit fatal_exit on a clean (zero) exit", () => {
    const proc = new FakeProcess();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    installProcessSafetyNet({
      proc: proc as never,
      exit: vi.fn(),
      cleanupSync: vi.fn(),
    });

    proc.emit("exit", 0);

    const fatalLines = errorSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .filter((entry) => entry["event"] === "fatal_exit");
    expect(fatalLines).toHaveLength(0);
  });

  it("writes the crash record synchronously and swallows write errors", () => {
    const proc = new FakeProcess();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writeCrashRecordSync = vi.fn((_record: CrashRecord) => {
      throw new Error("disk full");
    });

    installProcessSafetyNet({
      proc: proc as never,
      exit: vi.fn(),
      cleanupSync: vi.fn(),
      getDiagnostics: () => ({ uptimeMs: 9, inFlight: 1, queued: 2 }),
      writeCrashRecordSync,
    });

    // Must not throw despite the writer throwing (best-effort, never blocks exit).
    expect(() => proc.emit("exit", 1)).not.toThrow();
    expect(writeCrashRecordSync).toHaveBeenCalledTimes(1);
    expect(writeCrashRecordSync.mock.calls[0]?.[0]).toMatchObject({
      reason: "exit",
      uptimeMs: 9,
      inFlight: 1,
      queued: 2,
    });
  });

  it("disposer removes every listener it added", () => {
    const proc = new FakeProcess();
    const dispose = installProcessSafetyNet({
      proc: proc as never,
      exit: vi.fn(),
      cleanupSync: vi.fn(),
      cleanupAsync: vi.fn().mockResolvedValue(undefined),
    });

    expect(proc.listenerCount("uncaughtException")).toBe(1);
    expect(proc.listenerCount("unhandledRejection")).toBe(1);
    expect(proc.listenerCount("exit")).toBe(1);

    dispose();

    expect(proc.listenerCount("uncaughtException")).toBe(0);
    expect(proc.listenerCount("unhandledRejection")).toBe(0);
    expect(proc.listenerCount("exit")).toBe(0);
  });
});
