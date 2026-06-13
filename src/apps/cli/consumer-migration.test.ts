/**
 * Consumer migration tests — verify pool integration in MCP server,
 * CLI executor, and obsidian CLI.
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ── 12.1: MCP server transport.onclose calls drainAllPools ──────────────────

describe("MCP server transport.onclose (Req 11.1)", () => {
  let mockTransport: { onclose: (() => Promise<void>) | null };
  let mockDrainAllPools: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    mockTransport = { onclose: null };
    mockDrainAllPools = vi.fn().mockResolvedValue(undefined);
  });

  it("should assign drainAllPools to transport.onclose", async () => {
    // Verify by reading the source and checking the pattern
    const serverSource = fs.readFileSync(
      path.resolve("src/apps/mcp-server/server.ts"),
      "utf-8",
    );

    // The source must set transport.onclose to call drainAllPools
    expect(serverSource).toContain("transport.onclose");
    expect(serverSource).toContain("drainAllPools");

    // Verify the pattern: transport.onclose calls drainAllPools()
    expect(serverSource).toMatch(/transport\.onclose\s*=\s*async\s*\(\)\s*=>\s*\{[\s\S]*drainAllPools\(\)/);
  });

  it("should import drainAllPools from pool-registry", async () => {
    const serverSource = fs.readFileSync(
      path.resolve("src/apps/mcp-server/server.ts"),
      "utf-8",
    );

    expect(serverSource).toMatch(
      /import\s*\{[^}]*drainAllPools[^}]*\}\s*from\s*["'](?:\.\.\/)+infrastructure\/persistence\/pool-registry/,
    );
  });
});

// ── 12.2 & 12.3: CLI executor works with pool-backed adapter ───────────────

describe("CLI executor with pool-backed adapter (Req 11.2)", () => {
  it("should import createDatabaseAdapter (which uses pool internally)", () => {
    const executorSource = fs.readFileSync(
      path.resolve("src/apps/cli/executor.ts"),
      "utf-8",
    );

    expect(executorSource).toMatch(
      /import\s*\{[^}]*createDatabaseAdapter[^}]*\}\s*from\s*["'](?:\.\.\/)+infrastructure\/persistence\/database-adapter/,
    );
  });

  it("should call adapter.close() in finally blocks for executeIndexingPipeline", () => {
    const executorSource = fs.readFileSync(
      path.resolve("src/apps/cli/executor.ts"),
      "utf-8",
    );

    // executeIndexingPipeline has a finally block that calls adapter.close()
    expect(executorSource).toContain("finally");
    expect(executorSource).toContain("adapter.close()");
  });

  it("should call adapter.close() in readGraphStatus", () => {
    const executorSource = fs.readFileSync(
      path.resolve("src/apps/cli/executor.ts"),
      "utf-8",
    );

    // readGraphStatus also has a finally block with adapter.close()
    const readGraphStatusMatch = executorSource.match(
      /async function readGraphStatus[\s\S]*?^}/m,
    );
    expect(readGraphStatusMatch).not.toBeNull();
    expect(readGraphStatusMatch![0]).toContain("adapter.close()");
  });

  it("should NOT import createLadybugConnection directly", () => {
    const executorSource = fs.readFileSync(
      path.resolve("src/apps/cli/executor.ts"),
      "utf-8",
    );

    expect(executorSource).not.toContain("createLadybugConnection");
  });
});

// ── 12.4: Obsidian CLI calls drainAllPools on exit ──────────────────────────

describe("Obsidian CLI drainAllPools on exit (Req 11.3)", () => {
  it("should import drainAllPools from pool-registry", () => {
    const obsidianSource = fs.readFileSync(
      path.resolve("src/apps/cli/obsidian-main.ts"),
      "utf-8",
    );

    expect(obsidianSource).toMatch(
      /import\s*\{[^}]*drainAllPools[^}]*\}\s*from\s*["'](?:\.\.\/)+infrastructure\/persistence\/pool-registry/,
    );
  });

  it("should call drainAllPools() before process.exit on success path", () => {
    const obsidianSource = fs.readFileSync(
      path.resolve("src/apps/cli/obsidian-main.ts"),
      "utf-8",
    );

    // Verify drainAllPools is called before process.exit(0)
    const drainIdx = obsidianSource.indexOf("drainAllPools()");
    const exitIdx = obsidianSource.indexOf("process.exit(0)");
    expect(drainIdx).toBeGreaterThan(-1);
    expect(exitIdx).toBeGreaterThan(-1);
    expect(drainIdx).toBeLessThan(exitIdx);
  });

  it("should call drainAllPools() before process.exit on error path", () => {
    const obsidianSource = fs.readFileSync(
      path.resolve("src/apps/cli/obsidian-main.ts"),
      "utf-8",
    );

    // The catch block should also call drainAllPools before exit(1)
    const catchBlock = obsidianSource.slice(
      obsidianSource.lastIndexOf("catch"),
    );
    expect(catchBlock).toContain("drainAllPools()");
    expect(catchBlock).toContain("process.exit(1)");
  });

  it("should NOT import createLadybugConnection directly", () => {
    const obsidianSource = fs.readFileSync(
      path.resolve("src/apps/cli/obsidian-main.ts"),
      "utf-8",
    );

    expect(obsidianSource).not.toContain("createLadybugConnection");
  });
});


// ── 12.5: No production code outside src/db/ imports createLadybugConnection ─

describe("No direct createLadybugConnection outside src/db/ (Req 11.4)", () => {
  it("should not have createLadybugConnection imports in production code outside src/db/", () => {
    const srcDir = path.resolve("src");
    const dbDir = path.resolve("src/infrastructure/persistence");
    const violations: string[] = [];

    function walkDir(dir: string): void {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Skip node_modules and db directory
          if (entry.name === "node_modules") continue;
          if (fullPath === dbDir) continue;
          walkDir(fullPath);
        } else if (
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".test.ts") &&
          !entry.name.endsWith(".spec.ts")
        ) {
          const content = fs.readFileSync(fullPath, "utf-8");
          if (content.includes("createLadybugConnection")) {
            violations.push(path.relative(srcDir, fullPath));
          }
        }
      }
    }

    walkDir(srcDir);

    expect(violations).toEqual([]);
  });
});
