/**
 * Tests for stopConnectionServer — the `typocop stop-server` mechanism.
 *
 * Stops the LadybugDB connection server by reading its discovery file for the
 * owning pid and SIGTERM-ing it (graceful shutdown). process.kill is spied so
 * the test never signals a real process; the discovery file is a real temp file
 * so readDiscoveryFile's parse/missing-file paths are exercised end-to-end.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopConnectionServer } from "./autostart-runtime.js";

async function withDiscovery(pid: number | undefined, run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "tpc-stop-"));
  const path = join(dir, "discovery.json");
  if (pid !== undefined) {
    await writeFile(path, JSON.stringify({ pid, startedAt: "now", prefix: "tpc_", dbPath: "/x", url: "grpc://127.0.0.1:7617" }));
  }
  try {
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

afterEach(() => vi.restoreAllMocks());

describe("stopConnectionServer", () => {
  it("returns stopped:false when there is no discovery file (idempotent no-op)", async () => {
    await withDiscovery(undefined, async (path) => {
      const result = await stopConnectionServer(path);
      expect(result.stopped).toBe(false);
      expect(result.reason).toMatch(/no discovery file/i);
    });
  });

  it("SIGTERMs the discovery pid and reports stopped once the process exits", async () => {
    await withDiscovery(4242, async (path) => {
      let killed = false;
      const sigterm = vi.fn();
      vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
        if (signal === "SIGTERM") {
          sigterm(pid);
          killed = true;
          return true;
        }
        // signal 0 = liveness probe: alive until the SIGTERM "kills" it.
        if (killed) {
          const err = new Error("ESRCH") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        return true;
      }) as typeof process.kill);

      const result = await stopConnectionServer(path, { timeoutMs: 1000 });
      expect(result).toEqual({ stopped: true, pid: 4242 });
      expect(sigterm).toHaveBeenCalledWith(4242);
    });
  });

  it("returns stopped:false (stale) when the discovery pid is not alive", async () => {
    await withDiscovery(9999, async (path) => {
      vi.spyOn(process, "kill").mockImplementation((() => {
        const err = new Error("ESRCH") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }) as typeof process.kill);

      const result = await stopConnectionServer(path);
      expect(result.stopped).toBe(false);
      expect(result.pid).toBe(9999);
      expect(result.reason).toMatch(/stale/i);
    });
  });
});
