/**
 * Git port (C1).
 *
 * Abstracts read-only git access (repository detection, working-tree / staged /
 * ref-compare diffs, current ref) behind a pure interface so the application
 * layer never shells out directly. The shell-out implementation lives in
 * `infrastructure/git/git-adapter.ts`.
 *
 * LAYERING: `core/` is a leaf — these are pure, JSON-serialisable data
 * contracts with NO `node:` imports and no behaviour.
 */

/** Which diff to compute. */
export type DiffScope = "unstaged" | "staged" | "all" | "compare";

/**
 * Change status of a single file in a diff. `renamed` carries {@link FileDiff.oldPath}.
 */
export type FileDiffStatus = "added" | "modified" | "deleted" | "renamed";

/**
 * One hunk's new-file line range, parsed from a unified-diff `@@ -a,b +c,d @@`
 * header. `newStart` is 1-based; `newLines` is the count of lines on the new
 * side (0 for a pure deletion hunk).
 */
export interface DiffHunk {
  readonly newStart: number;
  readonly newLines: number;
}

/**
 * A single changed file. `path` is cwd-relative with forward slashes (so it
 * matches persisted `Symbol.filePath`). For a `renamed` file `path` is the new
 * path and `oldPath` is the previous path. `deleted` files and pure additions
 * carry no usable hunks (whole-file change → all symbols affected); for
 * `modified`/`renamed` files `hunks` are the new-side line ranges that changed.
 */
export interface FileDiff {
  readonly path: string;
  readonly status: FileDiffStatus;
  readonly oldPath?: string;
  readonly hunks: readonly DiffHunk[];
}

/**
 * Read-only git access used by the change-driven features (C1/C2/C3).
 *
 * Implementations MUST be self-contained (only `node:` builtins + these core
 * types) to satisfy the `infra-no-sibling` layering rule.
 */
export interface GitPort {
  /** True when the cwd is inside a git work tree. NEVER throws. */
  isRepository(): Promise<boolean>;
  /**
   * Compute the changed files for the given scope:
   * - `unstaged` — working tree vs index (`git diff`)
   * - `staged`   — index vs HEAD (`git diff --cached`)
   * - `all`      — working tree + index vs HEAD (`git diff HEAD`)
   * - `compare`  — `baseRef...HEAD` (requires `baseRef`)
   *
   * Paths are normalised to cwd-relative forward-slash form and ignore-filtered.
   */
  diff(scope: DiffScope, baseRef?: string): Promise<FileDiff[]>;
  /** The current ref (short HEAD sha, or branch name). */
  currentRef(): Promise<string>;
}
