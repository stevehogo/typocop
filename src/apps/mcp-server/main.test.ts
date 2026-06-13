/**
 * Unit tests for src/mcp/main.ts
 *
 * Strategy:
 * - vi.mock is hoisted and intercepts all imports of the mocked modules.
 * - vi.resetModules() is called in beforeEach so each test gets a fresh
 *   module evaluation when it dynamically imports main.ts.
 * - process.exit is mocked as a no-op (records calls without exiting).
 * - The MCP server stays alive on success — process.exit must NOT be called.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mock functions — defined at module scope so vi.mock factory can close over them.
const mockStartMCPServer = vi.fn();
const mockExistsSync = vi.fn();
const mockDotenvConfig = vi.fn();

// vi.mock is hoisted to the top of the file by vitest's transform.
// The factory closes over the module-scope variables above.
vi.mock("./index.js", () => ({
  startMCPServer: mockStartMCPServer,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

vi.mock("dotenv", () => ({
  config: mockDotenvConfig,
}));

describe("src/mcp/main.ts", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Reset module registry so each test gets a fresh main.ts evaluation.
    vi.resetModules();
    vi.clearAllMocks();

    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // No-op mock: records calls without actually exiting.
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: string | number | null) => undefined as never);
  });

  /**
   * Set process.argv and dynamically import main.ts so main() executes.
   * Captures any unhandledRejection events during the import to prevent
   * vitest from treating them as test failures.
   */
  async function runMain(argv: string[]): Promise<void> {
    process.argv = ["node", "typocop-mcp", ...argv];

    // Suppress unhandledRejection events that come from the module-level
    // main().catch(...) when process.exit is mocked as a no-op.
    const suppressRejection = (): void => { /* intentionally empty */ };
    process.on("unhandledRejection", suppressRejection);

    await import("./main.js");
    // Flush any remaining microtasks
    await new Promise((resolve) => setTimeout(resolve, 0));

    process.off("unhandledRejection", suppressRejection);
  }

  // ─── 5.4 Success path ────────────────────────────────────────────────────────

  describe("success path", () => {
    it("does NOT call process.exit when startMCPServer resolves", async () => {
      // Requirements: 5.4 — MCP server stays alive on success
      mockStartMCPServer.mockResolvedValue(undefined);

      await runMain([]);

      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("calls startMCPServer exactly once", async () => {
      // Requirements: 5.2
      mockStartMCPServer.mockResolvedValue(undefined);

      await runMain([]);

      expect(mockStartMCPServer).toHaveBeenCalledTimes(1);
    });
  });

  // ─── 5.3 Failure path ────────────────────────────────────────────────────────

  describe("failure path", () => {
    it("writes error message to stderr when startMCPServer rejects", async () => {
      // Requirements: 5.3
      const errMsg = "Failed to connect to Neo4j";
      mockStartMCPServer.mockRejectedValue(new Error(errMsg));

      await runMain([]);

      expect(stderrSpy).toHaveBeenCalledWith(errMsg + "\n");
    });

    it("calls process.exit(1) when startMCPServer rejects", async () => {
      // Requirements: 5.3
      mockStartMCPServer.mockRejectedValue(new Error("startup failure"));

      await runMain([]);

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("converts non-Error rejections to string for stderr", async () => {
      // Requirements: 5.3
      mockStartMCPServer.mockRejectedValue("plain string error");

      await runMain([]);

      expect(stderrSpy).toHaveBeenCalledWith("plain string error\n");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ─── 9.4 -e with existing file ───────────────────────────────────────────────

  describe("-e flag with existing env file", () => {
    it("calls dotenv.config before startMCPServer when file exists", async () => {
      // Requirements: 9.4
      mockExistsSync.mockReturnValue(true);

      const callOrder: string[] = [];
      mockDotenvConfig.mockImplementation(() => {
        callOrder.push("dotenv.config");
        return { parsed: {} };
      });
      mockStartMCPServer.mockImplementation(async () => {
        callOrder.push("startMCPServer");
      });

      await runMain(["-e", ".env.test"]);

      expect(mockExistsSync).toHaveBeenCalledWith(".env.test");
      expect(mockDotenvConfig).toHaveBeenCalledWith({ path: ".env.test", quiet: true });
      expect(callOrder.indexOf("dotenv.config")).toBeLessThan(
        callOrder.indexOf("startMCPServer")
      );
    });

    it("does not call process.exit when env file exists and server starts", async () => {
      // Requirements: 9.4, 5.4
      mockExistsSync.mockReturnValue(true);
      mockDotenvConfig.mockReturnValue({ parsed: {} });
      mockStartMCPServer.mockResolvedValue(undefined);

      await runMain(["-e", ".env.test"]);

      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("supports --env long form flag", async () => {
      // Requirements: 9.4
      mockExistsSync.mockReturnValue(true);
      mockDotenvConfig.mockReturnValue({ parsed: {} });
      mockStartMCPServer.mockResolvedValue(undefined);

      await runMain(["--env", ".env.production"]);

      expect(mockExistsSync).toHaveBeenCalledWith(".env.production");
      expect(mockDotenvConfig).toHaveBeenCalledWith({ path: ".env.production", quiet: true });
    });

    it("loads dotenv in quiet mode to avoid corrupting stdio MCP transport", async () => {
      mockExistsSync.mockReturnValue(true);
      mockDotenvConfig.mockReturnValue({ parsed: {} });
      mockStartMCPServer.mockResolvedValue(undefined);

      await runMain(["-e", ".env.test"]);

      expect(mockDotenvConfig).toHaveBeenCalledWith({
        path: ".env.test",
        quiet: true,
      });
    });
  });

  // ─── 9.6 -e with missing file ────────────────────────────────────────────────

  describe("-e flag with missing env file", () => {
    it("writes error to stderr when env file does not exist", async () => {
      // Requirements: 9.6
      mockExistsSync.mockReturnValue(false);

      await runMain(["-e", "/nonexistent/.env"]);

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("/nonexistent/.env")
      );
    });

    it("calls process.exit(1) when env file does not exist", async () => {
      // Requirements: 9.6
      mockExistsSync.mockReturnValue(false);

      await runMain(["-e", "/nonexistent/.env"]);

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("calls process.exit(1) before startMCPServer when env file is missing", async () => {
      // Requirements: 9.6 — exit(1) is called before startMCPServer
      // Note: process.exit is mocked as a no-op so execution continues, but
      // the ordering guarantee (exit before server start) is what we verify.
      mockExistsSync.mockReturnValue(false);

      const callOrder: string[] = [];
      exitSpy.mockImplementation((_code?: string | number | null) => {
        callOrder.push(`exit(${_code})`);
        return undefined as never;
      });
      mockStartMCPServer.mockImplementation(async () => {
        callOrder.push("startMCPServer");
      });

      await runMain(["-e", "/nonexistent/.env"]);

      expect(callOrder[0]).toBe("exit(1)");
      expect(callOrder.indexOf("exit(1)")).toBeLessThan(
        callOrder.indexOf("startMCPServer")
      );
    });
  });
});
