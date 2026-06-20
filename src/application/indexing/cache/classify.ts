/**
 * Parse-cache classification (A2) — PURE.
 *
 * Partitions the freshly walked file set against the loaded parse cache into the
 * four buckets {@link FileClassification} (`unchanged | changed | added |
 * removed`). No I/O, no side effects, deterministic: the inputs fully determine
 * the output, so it is trivially unit-testable and the pipeline's
 * reuse-vs-reparse decision is reproducible.
 *
 * Two-tier staleness (per the plan):
 * - A file already in the cache with a matching `parseVersion` AND matching
 *   `contentHash` is `unchanged` — its cached `{symbols,hints}` are reused.
 * - `mtimeMs` is only a HINT for the caller deciding whether to bother hashing;
 *   classification itself is authoritative on `contentHash`. This module accepts
 *   each file's already-computed `contentHash` so that the mtime/hash interplay
 *   is decided by the caller (which reads content once during parse). That makes
 *   the two adversarial cases explicit and testable here:
 *     - mtime-same / hash-different → `changed` (touched + edited; hash wins).
 *     - mtime-different / hash-same → `unchanged` (touched, not edited; hash wins).
 */
import type { FileNode } from "../../../core/file-node.js";
import type {
  CachedFileEntry,
  FileClassification,
} from "../../../core/ports/index-cache.js";
import { PARSE_VERSION } from "../../../infrastructure/parsing/parse-version.js";

/**
 * A walked file paired with its current content hash (computed once, from the
 * content the parser already read). When `contentHash` is omitted the file is
 * classified purely on presence + `parseVersion` (cache hit requires a hash
 * match, so a hash-less file with a cache entry is conservatively `changed`).
 */
export interface ClassifiableFile {
  readonly fileNode: FileNode;
  readonly contentHash?: string;
}

/**
 * Classify the current walk against the cache.
 *
 * @param files - Current walk, each optionally carrying its current contentHash.
 * @param cache - The loaded parse cache (`relPath → entry`).
 * @returns The four-bucket partition. `removed` = cache keys absent from `files`.
 */
export function classifyFiles(
  files: readonly ClassifiableFile[],
  cache: ReadonlyMap<string, CachedFileEntry>,
): FileClassification {
  const unchanged: FileNode[] = [];
  const changed: FileNode[] = [];
  const added: FileNode[] = [];

  const present = new Set<string>();

  for (const { fileNode, contentHash } of files) {
    present.add(fileNode.path);
    const entry = cache.get(fileNode.path);

    if (!entry) {
      added.push(fileNode);
      continue;
    }

    if (isFresh(entry, contentHash)) {
      unchanged.push(fileNode);
    } else {
      changed.push(fileNode);
    }
  }

  // Anything in the cache but not in the current walk has been removed on disk.
  const removed: string[] = [];
  for (const key of cache.keys()) {
    if (!present.has(key)) removed.push(key);
  }

  return { unchanged, changed, added, removed };
}

/**
 * A cached entry is fresh iff it was produced under the current PARSE_VERSION
 * AND its content hash matches the file's current content hash. `contentHash`
 * is authoritative — mtime is never consulted here (the caller uses mtime only
 * to decide whether to compute the hash at all).
 */
function isFresh(entry: CachedFileEntry, contentHash: string | undefined): boolean {
  if (entry.parseVersion !== PARSE_VERSION) return false;
  if (contentHash === undefined) return false;
  return entry.contentHash === contentHash;
}
