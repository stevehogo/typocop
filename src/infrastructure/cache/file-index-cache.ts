/**
 * Disk-backed parse cache (A2) — implements {@link IndexCachePort}.
 *
 * Layout: a single JSON manifest (`relPath → CachedFileEntry`) at the configured
 * path (the orchestrator, A5, derives it as `~/.typocop/<prefix>/cache/parse-cache.json`).
 *
 * Robustness contract:
 * - `load` NEVER throws. Missing file, unreadable file, malformed JSON, or a
 *   manifest that isn't the expected object shape all yield an EMPTY `Map`, so
 *   the pipeline degrades to a full parse rather than crashing.
 * - `save` writes atomically: a temp file in the same directory, then `rename`
 *   over the target. A reader therefore never observes a half-written manifest.
 * - `clear` removes the manifest (backing `--refresh`); a missing file is a
 *   no-op, never an error.
 *
 * LAYERING: self-contained — only `node:` builtins + the core port type. No
 * sibling-infra imports.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  CachedFileEntry,
  IndexCachePort,
} from "../../core/ports/index-cache.js";

/** On-disk manifest envelope. The `version` is the manifest format, not PARSE_VERSION. */
interface CacheManifest {
  readonly version: 1;
  readonly entries: Record<string, CachedFileEntry>;
}

const MANIFEST_VERSION = 1 as const;

/**
 * @param filePath - Absolute path to the JSON manifest file.
 */
export class FileIndexCache implements IndexCachePort {
  constructor(private readonly filePath: string) {}

  async load(): Promise<Map<string, CachedFileEntry>> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      // Missing or unreadable manifest → empty cache (full parse).
      return new Map();
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      const entries = extractEntries(parsed);
      if (!entries) return new Map();
      return new Map(Object.entries(entries));
    } catch {
      // Corrupt JSON → empty cache, never throw.
      return new Map();
    }
  }

  async save(entries: Map<string, CachedFileEntry>): Promise<void> {
    const manifest: CacheManifest = {
      version: MANIFEST_VERSION,
      entries: Object.fromEntries(entries),
    };
    const payload = JSON.stringify(manifest);

    await mkdir(dirname(this.filePath), { recursive: true });

    // Atomic temp + rename: a reader never sees a partial write. The temp lives
    // in the same directory so the rename is a same-filesystem atomic move.
    const tmpPath = join(
      dirname(this.filePath),
      `.parse-cache.${process.pid}.${Date.now()}.tmp`,
    );
    await writeFile(tmpPath, payload, "utf8");
    try {
      await rename(tmpPath, this.filePath);
    } catch (err) {
      // Clean up the orphaned temp on rename failure, then surface the error.
      await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}

/** Narrow an unknown parsed value to the manifest's `entries` record, else null. */
function extractEntries(
  parsed: unknown,
): Record<string, CachedFileEntry> | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const entries = obj.entries;
  if (typeof entries !== "object" || entries === null) return null;
  return entries as Record<string, CachedFileEntry>;
}
