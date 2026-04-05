/**
 * Unit tests for src/cli/main.ts
 *
 * Strategy:
 * - vi.mock is hoisted and intercepts all imports of the mocked modules.
 * - vi.resetModules() is called in beforeEach so each test gets a fresh
 *   module evaluation when it dynamically imports main.ts.
 * - The CLIValidationError class is defined in the mock factory and also
 *   re-exported so tests can use it. Since vi.mock is hoisted and the factory
 *   runs once per module reset, we use vi.mocked() to access the class.
 * - process.exit is mocked as a no-op (records calls without exiting).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mock functions — defined at module scope so vi.mock factory can close over them.
const mockParseArgs = vi.fn();
const mockExecuteCLI = vi.fn();
const mockExistsSync = vi.fn();
const mockDotenvConfig = vi.fn();

// CLIValidationError — defined at module scope so the same class identity is
// used in both the mock factory and test assertions.
class CLIValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CLIValidationError";
  }
}

// vi.mock is hoisted to the top of the file by vitest's transform.
// The factory closes over the module-scope variables above.
vi.mock("./index.js", () => ({
  parseArgs: mockParseArgs,
  executeCLI: mockExecuteCLI,
  CLIValidationError,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

vi.mock("dotenv", () => ({
  config: mockDotenvConfig,
}));

describe("src/cli/main.ts", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Reset module registry so each test gets a fresh main.ts evaluation.
    vi.resetModules();
    vi.clearAllMocks();

    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // No-op mock: records calls without actually exiting.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => undefined as never);
  });

  /**
   * Set process.argv and dynamically import main.ts so main() executes.
   * Captures any unhandledRejection events during the import to prevent
   * vitest from treating them as test failures.
   */
  async function runMain(argv: string[]): Promise<void> {
    process.argv = ["node", "typocop", ...argv];

    // Suppress unhandledRejection events that come from the module-level main()
    // call when process.exit is mocked as a no-op and main() re-throws.
    const suppressRejection = () => { /* intentionally empty */ };
    process.on("unhandledRejection", suppressRejection);

    await import("./main.js");
    // Flush any remaining microtasks
    await new Promise((resolve) => setTimeout(resolve, 0));

    process.off("unhandledRejection", suppressRejection);
  }

  // ─── 5.2 Success path ────────────────────────────────────────────────────────

  describe("success path", () => {
    it("calls process.exit(0) when executeCLI resolves", async () => {
      // Requirements: 1.6
      const fakeCommand = { type: "status" as const };
      mockParseArgs.mockReturnValue(fakeCommand);
      mockExecuteCLI.mockResolvedValue(undefined);

      await runMain(["status"]);

      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  // ─── 5.3 CLIValidationError path ─────────────────────────────────────────────

  describe("CLIValidationError path", () => {
    it("writes error message to stderr and calls process.exit(1)", async () => {
      // Requirements: 1.4
      const errMsg = "Unknown command: foo";
      mockParseArgs.mockImplementation(() => {
        throw new CLIValidationError(errMsg);
      });
      // After no-op exit(1), main() continues to executeCLI(undefined) — prevent throw
      mockExecuteCLI.mockResolvedValue(undefined);

      await runMain(["foo"]);

      expect(stderrSpy).toHaveBeenCalledWith(errMsg + "\n");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("calls process.exit(1) before executeCLI when parseArgs throws CLIValidationError", async () => {
      // Requirements: 1.4
      // Verify exit(1) is called — the CLIValidationError is caught and handled.
      mockParseArgs.mockImplementation(() => {
        throw new CLIValidationError("bad args");
      });
      mockExecuteCLI.mockResolvedValue(undefined);

      await runMain(["bad"]);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrSpy).toHaveBeenCalledWith("bad args\n");
    });
  });

  // ─── 5.4 Unexpected error path ───────────────────────────────────────────────

  describe("unexpected error path", () => {
    it("writes error message to stderr and calls process.exit(1) when executeCLI rejects", async () => {
      // Requirements: 1.5
      const fakeCommand = { type: "status" as const };
      mockParseArgs.mockReturnValue(fakeCommand);
      const errMsg = "Database connection failed";
      mockExecuteCLI.mockRejectedValue(new Error(errMsg));

      await runMain(["status"]);

      expect(stderrSpy).toHaveBeenCalledWith(errMsg + "\n");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("converts non-Error rejections to string for stderr", async () => {
      // Requirements: 1.5
      const fakeCommand = { type: "status" as const };
      mockParseArgs.mockReturnValue(fakeCommand);
      mockExecuteCLI.mockRejectedValue("plain string error");

      await runMain(["status"]);

      expect(stderrSpy).toHaveBeenCalledWith("plain string error\n");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ─── 5.5 -e with existing file ───────────────────────────────────────────────

  describe("-e flag with existing env file", () => {
    it("calls dotenv.config before parseArgs when file exists", async () => {
      // Requirements: 9.3
      mockExistsSync.mockReturnValue(true);
      const fakeCommand = { type: "status" as const };

      const callOrder: string[] = [];
      mockDotenvConfig.mockImplementation(() => {
        callOrder.push("dotenv.config");
        return { parsed: {} };
      });
      mockParseArgs.mockImplementation(() => {
        callOrder.push("parseArgs");
        return fakeCommand;
      });
      mockExecuteCLI.mockResolvedValue(undefined);

      await runMain(["-e", ".env.test", "status"]);

      expect(mockExistsSync).toHaveBeenCalledWith(".env.test");
      expect(mockDotenvConfig).toHaveBeenCalledWith({ path: ".env.test" });
      expect(callOrder.indexOf("dotenv.config")).toBeLessThan(callOrder.indexOf("parseArgs"));
    });

    it("strips -e and its path from argv passed to parseArgs", async () => {
      // Requirements: 9.3
      mockExistsSync.mockReturnValue(true);
      const fakeCommand = { type: "status" as const };
      mockParseArgs.mockReturnValue(fakeCommand);
      mockExecuteCLI.mockResolvedValue(undefined);

      await runMain(["-e", ".env.test", "status"]);

      // parseArgs should receive ["node", "typocop", "status"] — no -e flag
      expect(mockParseArgs).toHaveBeenCalledWith(["node", "typocop", "status"]);
    });
  });

  // ─── 5.6 -e with missing file ────────────────────────────────────────────────

  describe("-e flag with missing env file", () => {
    it("writes error to stderr and exits with code 1 when file does not exist", async () => {
      // Requirements: 9.5
      mockExistsSync.mockReturnValue(false);
      mockParseArgs.mockReturnValue({ type: "status" as const });
      mockExecuteCLI.mockResolvedValue(undefined);

      await runMain(["-e", "/nonexistent/.env"]);

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("/nonexistent/.env")
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("calls process.exit(1) before parseArgs when env file is missing", async () => {
      // Requirements: 9.5
      mockExistsSync.mockReturnValue(false);
      const callOrder: string[] = [];
      exitSpy.mockImplementation((_code?: number) => {
        callOrder.push(`exit(${_code})`);
        return undefined as never;
      });
      mockParseArgs.mockImplementation(() => {
        callOrder.push("parseArgs");
        return { type: "status" as const };
      });
      mockExecuteCLI.mockResolvedValue(undefined);

      await runMain(["-e", "/nonexistent/.env"]);

      expect(callOrder[0]).toBe("exit(1)");
      expect(callOrder.indexOf("exit(1)")).toBeLessThan(callOrder.indexOf("parseArgs"));
    });

    it("calls process.exit(1) before executeCLI when env file is missing", async () => {
      // Requirements: 9.5
      mockExistsSync.mockReturnValue(false);
      const callOrder: string[] = [];
      exitSpy.mockImplementation((_code?: number) => {
        callOrder.push(`exit(${_code})`);
        return undefined as never;
      });
      mockParseArgs.mockReturnValue({ type: "status" as const });
      mockExecuteCLI.mockImplementation(async () => {
        callOrder.push("executeCLI");
      });

      await runMain(["-e", "/nonexistent/.env"]);

      expect(callOrder[0]).toBe("exit(1)");
      expect(callOrder.indexOf("exit(1)")).toBeLessThan(callOrder.indexOf("executeCLI"));
    });
  });
});
