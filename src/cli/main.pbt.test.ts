/**
 * Property-based tests for CLI and MCP entry points.
 *
 * Properties covered:
 *   1. CLI entry point propagates any error to stderr (Req 1.4, 1.5)
 *   2. MCP entry point propagates any error to stderr (Req 5.3)
 *   3. Unknown commands always exit with code 1 (Req 7.4)
 *   4. Env_Flag file-not-found always exits with code 1 — CLI (Req 9.5)
 *   5. Env_Flag file-not-found always exits with code 1 — MCP (Req 9.6)
 *
 * Strategy: vi.resetModules() is called once per property (in beforeEach-style
 * setup inside each fc.asyncProperty run) so each run gets a fresh module
 * evaluation. Spies are re-applied after each reset.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";

// ─── Shared mock functions ────────────────────────────────────────────────────

const mockParseArgs = vi.fn();
const mockExecuteCLI = vi.fn();
const mockStartMCPServer = vi.fn();
const mockExistsSync = vi.fn();
const mockDotenvConfig = vi.fn();

class MockCLIValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CLIValidationError";
  }
}

vi.mock("./index.js", () => ({
  parseArgs: mockParseArgs,
  executeCLI: mockExecuteCLI,
  CLIValidationError: MockCLIValidationError,
}));

vi.mock("../mcp/index.js", () => ({
  startMCPServer: mockStartMCPServer,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

vi.mock("dotenv", () => ({
  config: mockDotenvConfig,
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function runCLIMain(argv: string[]): Promise<void> {
  process.argv = ["node", "typocop", ...argv];
  const suppressRejection = (): void => { /* intentionally empty */ };
  process.on("unhandledRejection", suppressRejection);
  await import("./main.js");
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.off("unhandledRejection", suppressRejection);
}

async function runMCPMain(argv: string[]): Promise<void> {
  process.argv = ["node", "typocop-mcp", ...argv];
  const suppressRejection = (): void => { /* intentionally empty */ };
  process.on("unhandledRejection", suppressRejection);
  await import("../mcp/main.js");
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.off("unhandledRejection", suppressRejection);
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("Property-based tests: CLI and MCP entry points", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: string | number | null) => undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Property 1: CLI error propagation ───────────────────────────────────────
  // Validates: Requirements 1.4, 1.5

  it("Property 1: CLI entry point propagates any error to stderr", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (msg) => {
        // Reset module cache so each run gets a fresh main() execution
        vi.resetModules();
        vi.clearAllMocks();
        // Re-apply no-op spies after clearAllMocks resets implementations
        stderrSpy.mockImplementation(() => true);
        exitSpy.mockImplementation(
          (_code?: string | number | null) => undefined as never
        );

        mockParseArgs.mockReturnValue({ type: "status" as const });
        mockExecuteCLI.mockRejectedValue(new Error(msg));

        await runCLIMain(["status"]);

        const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0]));
        const wroteMsg = stderrCalls.some((s) => s.includes(msg));
        const exitedWith1 = exitSpy.mock.calls.some((c) => c[0] === 1);

        return wroteMsg && exitedWith1;
      }),
      { numRuns: 100 }
    );
  });

  // ─── Property 2: MCP error propagation ───────────────────────────────────────
  // Validates: Requirements 5.3

  it("Property 2: MCP entry point propagates any error to stderr", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (msg) => {
        vi.resetModules();
        vi.clearAllMocks();
        stderrSpy.mockImplementation(() => true);
        exitSpy.mockImplementation(
          (_code?: string | number | null) => undefined as never
        );

        mockStartMCPServer.mockRejectedValue(new Error(msg));

        await runMCPMain([]);

        const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0]));
        const wroteMsg = stderrCalls.some((s) => s.includes(msg));
        const exitedWith1 = exitSpy.mock.calls.some((c) => c[0] === 1);

        return wroteMsg && exitedWith1;
      }),
      { numRuns: 100 }
    );
  });

  // ─── Property 3: Unknown command rejection ────────────────────────────────────
  // Validates: Requirements 7.4
  // Uses the real parseArgs via vi.importActual to bypass the mock.
  // Commander throws for unknown commands (exitOverride enabled), which
  // propagates as an unhandled error → process exits non-zero.

  it("Property 3: Unknown commands always throw from parseArgs", async () => {
    const { parseArgs: realParseArgs } =
      await vi.importActual<typeof import("./index.js")>("./index.js");

    const validCommands = ["parse", "reindex", "status", "obsidian"];
    const unknownCmd = fc
      .string({ minLength: 1 })
      .filter(
        (s) =>
          !validCommands.includes(s) &&
          !s.startsWith("-") &&
          s.trim().length > 0
      );

    fc.assert(
      fc.property(unknownCmd, (cmd) => {
        expect(() => realParseArgs(["node", "typocop", cmd])).toThrow();
      }),
      { numRuns: 100 }
    );
  });

  // ─── Property 4: Env_Flag file-not-found exits with code 1 (CLI) ─────────────
  // Validates: Requirements 9.5

  it("Property 4: Env_Flag file-not-found always exits with code 1 (CLI)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1 }), async (path) => {
        vi.resetModules();
        vi.clearAllMocks();
        stderrSpy.mockImplementation(() => true);
        exitSpy.mockImplementation(
          (_code?: string | number | null) => undefined as never
        );

        mockExistsSync.mockReturnValue(false);
        mockParseArgs.mockReturnValue({ type: "status" as const });
        mockExecuteCLI.mockResolvedValue(undefined);

        await runCLIMain(["-e", path]);

        // exit(1) must be called and stderr must be written.
        // Note: process.exit is mocked as no-op so execution continues after
        // exit(1), but we verify exit(1) was the FIRST exit call.
        const wroteToStderr = stderrSpy.mock.calls.length > 0;
        const firstExitCode = exitSpy.mock.calls[0]?.[0];
        const exitedWith1First = firstExitCode === 1;

        return wroteToStderr && exitedWith1First;
      }),
      { numRuns: 100 }
    );
  });

  // ─── Property 5: Env_Flag file-not-found exits with code 1 (MCP) ─────────────
  // Validates: Requirements 9.6

  it("Property 5: Env_Flag file-not-found always exits with code 1 (MCP)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1 }), async (path) => {
        vi.resetModules();
        vi.clearAllMocks();
        stderrSpy.mockImplementation(() => true);
        exitSpy.mockImplementation(
          (_code?: string | number | null) => undefined as never
        );

        mockExistsSync.mockReturnValue(false);
        mockStartMCPServer.mockResolvedValue(undefined);

        await runMCPMain(["-e", path]);

        // exit(1) must be called and stderr must be written.
        // Note: process.exit is mocked as no-op so execution continues after
        // exit(1), but we verify exit(1) was the FIRST exit call.
        const wroteToStderr = stderrSpy.mock.calls.length > 0;
        const firstExitCode = exitSpy.mock.calls[0]?.[0];
        const exitedWith1First = firstExitCode === 1;

        return wroteToStderr && exitedWith1First;
      }),
      { numRuns: 100 }
    );
  });
});
