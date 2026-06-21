/**
 * Git-diff → changed-symbols resolution (C1).
 *
 * Maps a set of {@link FileDiff}s onto the persisted graph: for each changed
 * file, find the `Symbol` nodes whose `[startLine, endLine]` range overlaps any
 * changed hunk. Whole-file changes (deleted files, pure additions, or modified
 * files with no parseable hunks) select EVERY symbol in that file.
 *
 * Pairs with `executePreCommitCheck` (which takes `changedFiles: string[]` for
 * blast-radius) — this layer additionally narrows to the precise symbol ids that
 * actually changed within each file.
 *
 * LAYERING: application use-case — talks to the DB only through
 * {@link GraphAdapter} (never shells out; git access is the caller's job via the
 * {@link import("../../core/ports/git.js").GitPort}).
 */
import type { GraphAdapter } from "../../core/ports/persistence.js";
import type { FileDiff } from "../../core/ports/git.js";

/** Result of resolving file diffs to graph symbols. */
export interface ChangedSymbols {
  /** Distinct cwd-relative file paths that had changed symbols (sorted). */
  readonly changedFiles: string[];
  /** Distinct persisted Symbol node ids (logicalKeys) that overlap a change (sorted). */
  readonly symbolIds: string[];
}

interface SymbolRangeRow {
  readonly id: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * True when a file's changes affect the WHOLE file (so every symbol in it is
 * implicated): a deletion, or any change with no usable hunk ranges (added
 * files report no new-side hunks under `--unified=0` in some git versions, and
 * binary/blob-level changes carry none either).
 */
function isWholeFileChange(diff: FileDiff): boolean {
  return diff.status === "deleted" || diff.hunks.length === 0;
}

/**
 * Resolve a set of file diffs to the symbol ids they touch.
 *
 * Strategy (one Cypher query):
 * 1. Select all `Symbol` rows in the changed files (`s.filePath IN $paths`),
 *    returning `id` + `filePath` + line range.
 * 2. In-process, for each row decide overlap: whole-file-change files match
 *    every row; otherwise the row's `[startLine,endLine]` must intersect at
 *    least one hunk `[newStart, newStart+newLines-1]`.
 *
 * Doing the overlap test in TS (rather than a complex Cypher range predicate)
 * keeps the query a single simple `IN` and is adapter-portable. The candidate
 * set is bounded by "symbols in the changed files", which is small.
 */
export async function resolveChangedSymbols(
  fileDiffs: readonly FileDiff[],
  graphAdapter: GraphAdapter,
): Promise<ChangedSymbols> {
  if (fileDiffs.length === 0) {
    return { changedFiles: [], symbolIds: [] };
  }

  // For a rename, both the old and new path may carry symbols (old rows linger
  // until re-index); include both so callers see the full blast radius.
  const pathSet = new Set<string>();
  for (const d of fileDiffs) {
    pathSet.add(d.path);
    if (d.oldPath) pathSet.add(d.oldPath);
  }
  const paths = [...pathSet];

  const rows = await graphAdapter.runCypher<SymbolRangeRow>(
    // NOTE: CAST(... AS INT64) — this backend has no `toInteger()`.
    `MATCH (s:Symbol)
     WHERE s.filePath IN $paths
     RETURN s.id AS id,
            s.filePath AS filePath,
            CAST(s.startLine AS INT64) AS startLine,
            CAST(s.endLine AS INT64) AS endLine`,
    { paths },
  );

  // Per-path hunk ranges (new-side, inclusive) and whole-file flags.
  const wholeFile = new Set<string>();
  const hunkRangesByPath = new Map<string, Array<[number, number]>>();
  for (const d of fileDiffs) {
    const targets = d.oldPath ? [d.path, d.oldPath] : [d.path];
    if (isWholeFileChange(d)) {
      for (const t of targets) wholeFile.add(t);
      continue;
    }
    const ranges = d.hunks.map(
      (h): [number, number] => [h.newStart, h.newStart + Math.max(h.newLines, 1) - 1],
    );
    for (const t of targets) {
      const existing = hunkRangesByPath.get(t);
      if (existing) existing.push(...ranges);
      else hunkRangesByPath.set(t, [...ranges]);
    }
  }

  const matchedIds = new Set<string>();
  const matchedFiles = new Set<string>();

  for (const row of rows) {
    const filePath = row.filePath;
    const rawStart = typeof row.startLine === "number" ? row.startLine : Number(row.startLine);
    const rawEnd = typeof row.endLine === "number" ? row.endLine : Number(row.endLine);
    const symStart = Number.isFinite(rawStart) ? rawStart : 0;
    const symEnd = Number.isFinite(rawEnd) ? rawEnd : symStart;

    if (wholeFile.has(filePath)) {
      matchedIds.add(row.id);
      matchedFiles.add(filePath);
      continue;
    }
    const ranges = hunkRangesByPath.get(filePath);
    if (!ranges) continue;
    const overlaps = ranges.some(([hStart, hEnd]) => symStart <= hEnd && symEnd >= hStart);
    if (overlaps) {
      matchedIds.add(row.id);
      matchedFiles.add(filePath);
    }
  }

  return {
    changedFiles: [...matchedFiles].sort(),
    symbolIds: [...matchedIds].sort(),
  };
}
