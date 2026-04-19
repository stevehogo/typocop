/**
 * VaultWriter — writes rendered vault content to the file system.
 * Requirements: 8.1–8.5, 9.4
 */
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join, dirname, resolve, normalize } from "node:path";

import type { VaultContent } from "./renderer.js";
import type { WriteResult } from "./index.js";

/**
 * Validates that no file in the vault content escapes the output directory
 * via directory traversal (Requirement 8.5).
 *
 * Checks BEFORE any files are written to prevent partial writes with
 * malicious paths.
 *
 * @throws Error if any relativePath contains traversal patterns
 */
function validateOutputPaths(outputPath: string, content: VaultContent): void {
  const resolvedOutput = resolve(outputPath);

  for (const file of content.files) {
    const normalized = normalize(file.relativePath);

    if (normalized.includes("..")) {
      throw new Error(
        `Directory traversal detected in path: "${file.relativePath}". ` +
          `Resolved path escapes output directory "${resolvedOutput}".`,
      );
    }

    const fullPath = resolve(resolvedOutput, normalized);

    if (!fullPath.startsWith(resolvedOutput)) {
      throw new Error(
        `Directory traversal detected in path: "${file.relativePath}". ` +
          `Resolved path "${fullPath}" escapes output directory "${resolvedOutput}".`,
      );
    }
  }
}

/**
 * Writes the rendered vault content to the file system.
 *
 * Algorithm:
 * 1. Validate all output paths (no traversal — Req 8.5)
 * 2. Remove existing output directory (Req 8.2)
 * 3. Write each file, creating directories as needed (Req 8.1, 8.3)
 * 4. Track and return statistics (Req 8.4)
 *
 * Partial write failures are logged and skipped (Req 9.4).
 */
export async function writeVault(outputPath: string, content: VaultContent): Promise<WriteResult> {
  validateOutputPaths(outputPath, content);

  await rm(outputPath, { recursive: true, force: true });

  let filesWritten = 0;
  let totalBytes = 0;
  const createdDirs = new Set<string>();

  for (const file of content.files) {
    const fullPath = join(outputPath, file.relativePath);
    const dir = dirname(fullPath);

    if (!createdDirs.has(dir)) {
      await mkdir(dir, { recursive: true });
      createdDirs.add(dir);
    }

    try {
      await writeFile(fullPath, file.content, "utf-8");
      filesWritten++;
      totalBytes += Buffer.byteLength(file.content, "utf-8");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[obsidian] Failed to write "${file.relativePath}": ${message}`);
    }
  }

  return { filesWritten, directoriesCreated: createdDirs.size, totalBytes };
}
