import { rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { DiscoveryFile } from "./types.js";

export async function writeDiscoveryFile(path: string, discovery: DiscoveryFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(discovery, null, 2)}\n`, "utf8");
}

/**
 * Best-effort read of an existing discovery file. Returns `null` when the file
 * is missing, empty, or unparseable. Used server-side to detect and log a stale
 * advertisement left by a previous (crashed) server before overwriting it
 * (resilience Phase D).
 */
export async function readDiscoveryFile(path: string): Promise<DiscoveryFile | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    return parsed as DiscoveryFile;
  } catch {
    return null;
  }
}

export async function removeDiscoveryFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

/**
 * Synchronous, best-effort discovery-file removal for use inside a
 * `process.on("exit")` handler, where the event loop is gone and async work
 * silently no-ops. Errors are swallowed — this is a last-ditch cleanup.
 */
export function removeDiscoveryFileSync(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // best-effort: nothing else can run at exit time
  }
}
