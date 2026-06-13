/**
 * Unit tests for VaultWriter — writeVault file system operations.
 * Requirements: 8.1–8.5
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeVault } from "./vault-writer.js";
import type { VaultContent } from "./renderer.js";

// --- Temp dir management ---

let tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vault-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

// --- 8.3: writeVault creates correct directory structure ---

describe("writeVault", () => {
  it("creates files in the correct directory structure", async () => {
    const baseDir = await createTempDir();
    const outputPath = join(baseDir, "vault-output");

    const content: VaultContent = {
      files: [
        { relativePath: "_index.md", content: "# Index\n" },
        { relativePath: "src/cli/parser.md", content: "# Parser\n" },
        { relativePath: "_clusters/core.md", content: "# Core\n" },
      ],
    };

    const result = await writeVault(outputPath, content);

    expect(result.filesWritten).toBe(3);
    expect(result.directoriesCreated).toBeGreaterThanOrEqual(3);
    expect(result.totalBytes).toBeGreaterThan(0);

    // Verify files exist with correct content
    const indexContent = await readFile(join(outputPath, "_index.md"), "utf-8");
    expect(indexContent).toBe("# Index\n");

    const parserContent = await readFile(join(outputPath, "src/cli/parser.md"), "utf-8");
    expect(parserContent).toBe("# Parser\n");

    const clusterContent = await readFile(join(outputPath, "_clusters/core.md"), "utf-8");
    expect(clusterContent).toBe("# Core\n");
  });

  it("reports correct byte count for written files", async () => {
    const baseDir = await createTempDir();
    const outputPath = join(baseDir, "vault-bytes");

    const fileContent = "Hello, Obsidian!";
    const content: VaultContent = {
      files: [{ relativePath: "test.md", content: fileContent }],
    };

    const result = await writeVault(outputPath, content);

    expect(result.filesWritten).toBe(1);
    expect(result.totalBytes).toBe(Buffer.byteLength(fileContent, "utf-8"));
  });

  // --- 8.4: Output path validation rejects traversal patterns ---

  it("throws when a file path contains directory traversal (..)", async () => {
    const baseDir = await createTempDir();
    const outputPath = join(baseDir, "vault-traversal");

    const content: VaultContent = {
      files: [{ relativePath: "../../etc/passwd", content: "malicious" }],
    };

    await expect(writeVault(outputPath, content)).rejects.toThrow(
      /[Dd]irectory traversal detected/,
    );
  });

  it("throws when a normalized path escapes the output directory", async () => {
    const baseDir = await createTempDir();
    const outputPath = join(baseDir, "vault-escape");

    const content: VaultContent = {
      files: [{ relativePath: "foo/../../outside.md", content: "escape" }],
    };

    await expect(writeVault(outputPath, content)).rejects.toThrow(
      /[Dd]irectory traversal detected/,
    );
  });

  it("does not write any files when traversal is detected", async () => {
    const baseDir = await createTempDir();
    const outputPath = join(baseDir, "vault-no-write");

    const content: VaultContent = {
      files: [
        { relativePath: "valid.md", content: "ok" },
        { relativePath: "../escape.md", content: "bad" },
      ],
    };

    await expect(writeVault(outputPath, content)).rejects.toThrow();

    // Output directory should not have been created
    const entries = await readdir(baseDir);
    expect(entries).not.toContain("vault-no-write");
  });
});
