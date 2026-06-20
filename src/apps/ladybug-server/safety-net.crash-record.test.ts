import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CrashRecord } from "./safety-net.js";
import { installProcessSafetyNet } from "./safety-net.js";

/**
 * Real-filesystem companion to safety-net.test.ts (resilience Phase F). The unit
 * test only asserts the `writeCrashRecordSync` callback fires; this proves that,
 * when wired to a REAL `appendFileSync` (exactly as server.ts wires it next to
 * the discovery file), a `.crash` record actually lands on disk on a fatal exit
 * — and that a clean exit writes nothing.
 *
 * Same FakeProcess + spy-`exit` pattern as safety-net.test.ts: a real
 * EventEmitter and a spy exit let us emit lifecycle events and assert disk state
 * with ZERO real process death (the real safety net would process.exit(1)).
 */
class FakeProcess extends EventEmitter {}

describe("installProcessSafetyNet — crash record on disk (real fs)", () => {
  let root: string;

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    root = await mkdtemp(join(tmpdir(), "typocop-ladybug-crash-record-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("writes a .crash record to disk on a fatal uncaughtException", async () => {
    const proc = new FakeProcess();
    const exit = vi.fn();
    const discoveryPath = join(root, "ladybug-server.json");
    const crashPath = `${discoveryPath}.crash`;
    const diagnostics = { uptimeMs: 4242, inFlight: 2, queued: 3 };

    installProcessSafetyNet({
      proc: proc as never,
      exit,
      cleanupSync: vi.fn(),
      cleanupAsync: vi.fn().mockResolvedValue(undefined),
      getDiagnostics: () => diagnostics,
      // Mirror server.ts: best-effort SYNC append next to the discovery file.
      writeCrashRecordSync: (record: CrashRecord) => {
        appendFileSync(crashPath, `${JSON.stringify(record)}\n`);
      },
    });

    proc.emit("uncaughtException", new Error("boom"));
    await new Promise((r) => setImmediate(r));

    expect(exit).toHaveBeenCalledWith(1);
    expect(existsSync(crashPath)).toBe(true);

    const lines = readFileSync(crashPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({
      reason: "uncaughtException",
      uptimeMs: diagnostics.uptimeMs,
      inFlight: diagnostics.inFlight,
      queued: diagnostics.queued,
    });
    // `at` is the only error/timestamp evidence carried in the record.
    expect(typeof record["at"]).toBe("string");
    expect(Number.isNaN(Date.parse(String(record["at"])))).toBe(false);
  });

  it("writes a .crash record to disk on a non-zero exit", () => {
    const proc = new FakeProcess();
    const discoveryPath = join(root, "ladybug-server.json");
    const crashPath = `${discoveryPath}.crash`;
    const diagnostics = { uptimeMs: 11, inFlight: 0, queued: 0 };

    installProcessSafetyNet({
      proc: proc as never,
      exit: vi.fn(),
      cleanupSync: vi.fn(),
      getDiagnostics: () => diagnostics,
      writeCrashRecordSync: (record: CrashRecord) => {
        appendFileSync(crashPath, `${JSON.stringify(record)}\n`);
      },
    });

    proc.emit("exit", 1);

    expect(existsSync(crashPath)).toBe(true);
    const lines = readFileSync(crashPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      reason: "exit",
      uptimeMs: diagnostics.uptimeMs,
      inFlight: diagnostics.inFlight,
      queued: diagnostics.queued,
    });
  });

  it("writes NO crash record on a clean (zero) exit", () => {
    const proc = new FakeProcess();
    const discoveryPath = join(root, "ladybug-server.json");
    const crashPath = `${discoveryPath}.crash`;

    installProcessSafetyNet({
      proc: proc as never,
      exit: vi.fn(),
      cleanupSync: vi.fn(),
      getDiagnostics: () => ({ uptimeMs: 1, inFlight: 0, queued: 0 }),
      writeCrashRecordSync: (record: CrashRecord) => {
        appendFileSync(crashPath, `${JSON.stringify(record)}\n`);
      },
    });

    proc.emit("exit", 0);

    expect(existsSync(crashPath)).toBe(false);
  });
});
