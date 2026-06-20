/**
 * Phase D — self-healing startup, end-to-end (resilience follow-up #3).
 *
 * Existing Phase D coverage (server.reclaim.test.ts, file-lock.test.ts) is
 * unit/mock only. This test boots a REAL `startConnectionServer` over GENUINE
 * orphaned state — a stale discovery file pointing at a dead pid AND a stale
 * proper-lockfile lock left by a "crashed" holder — and asserts the server
 * self-heals (no DatabaseLockedError, bounded start time), overwrites the stale
 * advertisement with THIS process's pid, and reports Health = SERVING. No manual
 * cleanup of the orphaned state is performed before start.
 *
 * Harness mirrors connection-server.integration.test.ts EXACTLY: @grpc/grpc-js
 * and @grpc/proto-loader are mocked (no real network/ports), but the runtime
 * (real Kùzu), filesystem (mkdtemp temp dirs), discovery files, and
 * proper-lockfile locks are all REAL.
 *
 * The stale lock is planted as a genuine on-disk proper-lockfile lock — the
 * exact directory (`<dbPath>.lock.lock`) proper-lockfile creates for a held
 * lock — with a back-dated mtime so it is already past the stale window. This
 * reproduces a CRASHED holder precisely (an orphaned lock dir with no live
 * owner and no mtime-refresh timer) without taking an in-process lock that
 * would conflict with the server's own acquire on the same path. proper-lockfile
 * clamps its `stale` option to a 2000ms floor, so a back-dated mtime — rather
 * than a tiny stale window + sleep — is the reliable way to make the lock stale.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@grpc/proto-loader", async () => {
  const { createProtoLoaderMock } = await import("../../../tests/support/grpc-test-mocks.js");
  return createProtoLoaderMock();
});

vi.mock("@grpc/grpc-js", async () => {
  const { createGrpcJsMock } = await import("../../../tests/support/grpc-test-mocks.js");
  return createGrpcJsMock();
});

import { writeDiscoveryFile, readDiscoveryFile } from "../../infrastructure/remote-transport/discovery.js";
import { startConnectionServer } from "./server.js";
import {
  invokeUnary,
  makeServerConfig,
} from "../../../tests/support/connection-server.test-support.js";

/** Spawn a trivial child, await its exit, and return its now-dead pid. */
async function spawnDeadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
  const pid = child.pid;
  if (typeof pid !== "number") {
    throw new Error("spawned child had no pid");
  }
  return pid;
}

/** Best-effort liveness probe (mirrors the server's own isPidAlive). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Plant a genuine, already-stale proper-lockfile lock for `dbPath`, as a crashed
 * holder would leave behind. `acquireFileLock(dbPath)` locks `<dbPath>.lock` via
 * proper-lockfile, which represents a held lock as the directory
 * `<dbPath>.lock.lock`; we create exactly that directory and back-date its mtime
 * past the stale window. We also write the plain `<dbPath>.lock` pid payload
 * (the dead holder's pid) that `acquireFileLock` records on acquire, so the
 * crashed-holder shape is faithful.
 */
async function plantStaleLock(dbPath: string, holderPid: number, ageMs: number): Promise<void> {
  const lockFilePath = `${dbPath}.lock`;
  const properLockDir = `${lockFilePath}.lock`;
  await mkdir(properLockDir, { recursive: true });
  await writeFile(lockFilePath, `${holderPid}\n`, "utf8");
  const past = new Date(Date.now() - ageMs);
  await utimes(properLockDir, past, past);
}

describe("Ladybug connection server — crash-recovery integration tests", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");
    const grpcModule = await import("@grpc/grpc-js") as unknown as {
      readonly __clearServers: () => void;
    };
    grpcModule.__clearServers();
  });

  it(
    "self-heals a stale discovery file + stale lock and starts within a bounded time",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "typocop-ladybug-crash-"));

      // Thread the lock stale window through config — no process.env mutation.
      // proper-lockfile clamps `stale` to a 2000ms floor, so 2000 is the smallest
      // explicit window; the planted lock is back-dated well past it (below) so it
      // is unambiguously stale at acquire time. This exercises the full threading
      // path: LadybugServerConfig.lockStaleMs -> runtime.open -> acquireFileLock.
      const serverConfig = makeServerConfig(root, { port: 7621, lockStaleMs: 2_000 });

      // (a) STALE discovery file: advertise a guaranteed-dead pid.
      const deadPid = await spawnDeadPid();
      expect(isPidAlive(deadPid)).toBe(false);
      await writeDiscoveryFile(serverConfig.discoveryPath, {
        pid: deadPid,
        startedAt: "2026-06-14T00:00:00.000Z",
        prefix: serverConfig.prefix,
        dbPath: serverConfig.dbPath,
        url: `grpc://${serverConfig.host}:${serverConfig.port}`,
      });

      // (b) STALE lock: a "crashed" holder left an orphaned proper-lockfile lock
      // dir whose mtime is far older than the stale window — exactly what a
      // crash leaves behind (no live owner, no refresh timer). proper-lockfile
      // reclaims it on the server's next acquire.
      await plantStaleLock(serverConfig.dbPath, deadPid, 60_000);

      let server: Awaited<ReturnType<typeof startConnectionServer>> | null = null;
      try {
        const startedAt = Date.now();
        // Self-healing start: must NOT throw DatabaseLockedError despite the
        // planted lock, and must overwrite the stale discovery advertisement.
        server = await startConnectionServer(serverConfig);
        const elapsedMs = Date.now() - startedAt;

        // Bounded: a self-heal of stale state should be near-instant, well under
        // the multi-second lock-retry budget (this is the assertion that fails
        // loudly if reclaim regresses into a full retry/timeout cycle).
        expect(elapsedMs).toBeLessThan(5_000);

        // reclaimStaleDiscovery + writeDiscoveryFile overwrote the dead-pid
        // record with THIS process's pid.
        const discovery = await readDiscoveryFile(serverConfig.discoveryPath);
        expect(discovery).not.toBeNull();
        expect(discovery?.pid).toBe(process.pid);
        expect(discovery?.pid).not.toBe(deadPid);
        expect(discovery?.url).toBe(`grpc://${serverConfig.host}:${serverConfig.port}`);

        // Health.Check returns SERVING — the runtime opened over the reclaimed
        // lock and the scheduler accepts work. Invoke the registered handler via
        // the grpc mock's server registry (no real socket).
        const grpcModule = await import("@grpc/grpc-js") as unknown as {
          readonly __getServer: (address: string) => {
            readonly implementations: Map<string, Record<string, (...args: unknown[]) => unknown>>;
          } | undefined;
        };
        const fakeServer = grpcModule.__getServer(`${serverConfig.host}:${serverConfig.port}`);
        expect(fakeServer).toBeDefined();
        const health = fakeServer?.implementations.get("Health");
        expect(health?.Check).toBeTypeOf("function");
        const healthResponse = (await invokeUnary(
          health!.Check as (call: unknown, cb: (e: unknown, r?: unknown) => void) => void,
          {},
        )) as { readonly status: number; readonly message: string };
        expect(healthResponse.status).toBe(1);
        expect(healthResponse.message).toBe("SERVING");
      } finally {
        if (server) {
          await server.shutdown("test");
        }
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
