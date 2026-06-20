import { EventEmitter } from "node:events";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireFileLock,
  releaseFileLockSync,
} from "../../infrastructure/persistence/file-lock.js";
import {
  removeDiscoveryFileSync,
  writeDiscoveryFile,
} from "../../infrastructure/remote-transport/discovery.js";
import type { DiscoveryFile } from "../../infrastructure/remote-transport/types.js";
import { installProcessSafetyNet } from "./safety-net.js";

/**
 * Real-filesystem assertion of the resilience Phase A guarantee: a fatal exit
 * leaves NO discovery file and NO held lock behind. The unit suite in
 * safety-net.test.ts proves the callbacks fire (fake EventEmitter + spy exit);
 * this suite wires those SAME injectable seams to the REAL
 * removeDiscoveryFileSync + releaseFileLockSync against REAL artifacts in a
 * mkdtemp temp dir, then asserts at the fs level that both are gone.
 *
 * The fake `proc` (EventEmitter) + spy `exit` mean we emit the lifecycle events
 * WITHOUT touching the real process safety net (which would process.exit(1)).
 */
class FakeProcess extends EventEmitter {}

/** True iff the path does NOT exist (ENOENT) — i.e. the artifact was removed. */
async function isGone(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

describe("installProcessSafetyNet real-fs crash cleanup", () => {
  let tempDir: string;
  let dbPath: string;
  let discoveryPath: string;
  let lockPath: string;
  /** proper-lockfile's actual held lock is the `${lockPath}.lock` directory. */
  let lockDir: string;

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    tempDir = await mkdtemp(join(tmpdir(), "safety-net-crash-"));
    dbPath = join(tempDir, "db");
    discoveryPath = join(tempDir, "discovery.json");
    lockPath = `${dbPath}.lock`;
    lockDir = `${lockPath}.lock`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  /** Create the on-disk artifacts a started server holds: discovery file + lock. */
  async function createServerArtifacts(): Promise<void> {
    const discovery: DiscoveryFile = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      prefix: "test",
      dbPath,
      url: "127.0.0.1:0",
    };
    await writeDiscoveryFile(discoveryPath, discovery);
    await acquireFileLock(dbPath);

    // Sanity: both artifacts really exist before we exercise the safety net.
    expect(await isGone(discoveryPath)).toBe(false);
    expect((await stat(lockDir)).isDirectory()).toBe(true);
  }

  it("exit handler removes the real discovery file and the real lock", async () => {
    await createServerArtifacts();

    const proc = new FakeProcess();
    const exit = vi.fn();
    const cleanupSync = vi.fn(() => {
      removeDiscoveryFileSync(discoveryPath);
      releaseFileLockSync(lockPath);
    });

    const dispose = installProcessSafetyNet({
      proc: proc as never,
      exit,
      cleanupSync,
    });

    proc.emit("exit", 1);

    expect(cleanupSync).toHaveBeenCalledTimes(1);
    expect(await isGone(discoveryPath)).toBe(true);
    expect(await isGone(lockDir)).toBe(true);

    dispose();
  });

  it("uncaughtException runs async cleanup + exit(1), then exit drops the real artifacts", async () => {
    await createServerArtifacts();

    const proc = new FakeProcess();
    const exit = vi.fn();
    // Mirror the server: a single cleanedUp guard shared by sync + async so the
    // fatal path and the exit path never double-remove. Both remove the SAME
    // real artifacts via the real removeDiscoveryFileSync + releaseFileLockSync.
    let cleanedUp = false;
    const removeArtifacts = (): void => {
      removeDiscoveryFileSync(discoveryPath);
      releaseFileLockSync(lockPath);
    };
    const cleanupAsync = vi.fn(async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      removeArtifacts();
    });
    const cleanupSync = vi.fn(() => {
      if (cleanedUp) return;
      cleanedUp = true;
      removeArtifacts();
    });

    const dispose = installProcessSafetyNet({
      proc: proc as never,
      exit,
      cleanupSync,
      cleanupAsync,
    });

    proc.emit("uncaughtException", new Error("boom"));
    await new Promise((r) => setImmediate(r));

    // The fatal path ran async cleanup and exited non-zero...
    expect(cleanupAsync).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    // ...which already removed the real artifacts.
    expect(await isGone(discoveryPath)).toBe(true);
    expect(await isGone(lockDir)).toBe(true);

    // The subsequent exit handler's sync cleanup must no-op (guarded) and leave
    // the artifacts gone — never resurrecting or erroring on the missing files.
    proc.emit("exit", 1);
    expect(await isGone(discoveryPath)).toBe(true);
    expect(await isGone(lockDir)).toBe(true);

    dispose();
  });
});
