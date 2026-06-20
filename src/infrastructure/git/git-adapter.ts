/**
 * Git adapter (C1) — shells out to the `git` binary via `node:child_process`
 * `execFile` (NO new dependency; mirrors the spawn stance in
 * `infrastructure/remote-transport/autostart-runtime.ts`).
 *
 * LAYERING: self-contained — only `node:` builtins, the {@link GitPort} core
 * contract, and the leaf `platform/utils/ignore` helper. No sibling-infra
 * imports (`infra-no-sibling`).
 *
 * The diff PARSING is split into pure functions ({@link parseNameStatus},
 * {@link parseUnifiedDiff}) so it is unit-testable over canned `git` output with
 * no real repository.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { shouldIgnorePath } from "../../platform/utils/ignore.js";
import type {
  DiffHunk,
  DiffScope,
  FileDiff,
  FileDiffStatus,
  GitPort,
} from "../../core/ports/git.js";

const execFileAsync = promisify(execFile);

/** Max bytes of `git` stdout we will buffer (diffs can be large). */
const MAX_BUFFER = 64 * 1024 * 1024;

// ─── Pure parsers (testable without a real repo) ──────────────────────────────

/**
 * Parse `git diff --name-status -z`-style output. We accept the human (newline,
 * tab-separated) form: each record is `STATUS\tPATH` or, for renames/copies,
 * `Rxxx\tOLDPATH\tNEWPATH`.
 *
 * Returns one entry per file with its status and (for renames) the old path. No
 * hunks here — those come from {@link parseUnifiedDiff}.
 */
export function parseNameStatus(
  raw: string,
): Array<{ status: FileDiffStatus; path: string; oldPath?: string }> {
  const out: Array<{ status: FileDiffStatus; path: string; oldPath?: string }> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed.length === 0) continue;
    const fields = trimmed.split("\t");
    const code = fields[0]?.trim() ?? "";
    if (code.length === 0) continue;
    const letter = code[0];
    switch (letter) {
      case "A":
        if (fields[1]) out.push({ status: "added", path: fields[1] });
        break;
      case "D":
        if (fields[1]) out.push({ status: "deleted", path: fields[1] });
        break;
      case "M":
      case "T": // typechange — treat as a modification
        if (fields[1]) out.push({ status: "modified", path: fields[1] });
        break;
      case "R": // rename: R<score>\told\tnew
      case "C": // copy:   C<score>\told\tnew (new file derived from old)
        if (fields[1] && fields[2]) {
          out.push({
            status: letter === "R" ? "renamed" : "added",
            path: fields[2],
            oldPath: fields[1],
          });
        }
        break;
      default:
        // Unknown status (U=unmerged, X, B) — skip silently.
        break;
    }
  }
  return out;
}

/**
 * Parse a full unified diff (`git diff -U0` or default) into per-file new-side
 * hunk ranges keyed by the file's new path. Reads the `+++ b/<path>` header and
 * each `@@ -a,b +c,d @@` hunk header; computes `{ newStart, newLines }` per hunk.
 *
 * A `@@ -a,b +c @@` header (no comma after `+c`) means `newLines === 1`.
 * `/dev/null` new path (a deletion) yields no entries — the caller already knows
 * the file is deleted from `--name-status`.
 */
export function parseUnifiedDiff(raw: string): Map<string, DiffHunk[]> {
  const byPath = new Map<string, DiffHunk[]>();
  let currentPath: string | null = null;
  const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

  for (const line of raw.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target === "/dev/null") {
        currentPath = null;
        continue;
      }
      // Strip the `b/` (or arbitrary diff) prefix git prepends.
      currentPath = target.startsWith("b/") ? target.slice(2) : target;
      if (!byPath.has(currentPath)) byPath.set(currentPath, []);
      continue;
    }
    const m = hunkHeader.exec(line);
    if (m && currentPath) {
      const newStart = parseInt(m[1], 10);
      const newLines = m[2] === undefined ? 1 : parseInt(m[2], 10);
      byPath.get(currentPath)!.push({ newStart, newLines });
    }
  }
  return byPath;
}

/**
 * Merge `--name-status` records with parsed unified-diff hunks, normalise paths
 * to cwd-relative forward-slash form, and drop ignored files.
 *
 * `repoRelToCwdRel` converts a repo-root-relative path (what git emits) to a
 * cwd-relative path. Pure: pass in the prefix so this is testable without fs.
 */
export function combineDiff(
  nameStatus: Array<{ status: FileDiffStatus; path: string; oldPath?: string }>,
  hunksByPath: Map<string, DiffHunk[]>,
  repoRelToCwdRel: (repoRelPath: string) => string,
): FileDiff[] {
  const out: FileDiff[] = [];
  for (const entry of nameStatus) {
    const cwdRel = repoRelToCwdRel(entry.path);
    if (shouldIgnorePath(cwdRel)) continue;
    const hunks = hunksByPath.get(entry.path) ?? [];
    const diff: FileDiff = {
      path: cwdRel,
      status: entry.status,
      hunks: entry.status === "deleted" ? [] : hunks,
      ...(entry.oldPath !== undefined
        ? { oldPath: repoRelToCwdRel(entry.oldPath) }
        : {}),
    };
    out.push(diff);
  }
  return out;
}

// ─── Adapter ───────────────────────────────────────────────────────────────────

/** Translate a {@link DiffScope} into the variant flags for `git diff`. */
function diffArgs(scope: DiffScope, baseRef?: string): string[] {
  switch (scope) {
    case "staged":
      return ["--cached"];
    case "all":
      return ["HEAD"];
    case "compare":
      if (!baseRef) throw new Error("compare scope requires a baseRef");
      return [`${baseRef}...HEAD`];
    case "unstaged":
    default:
      return [];
  }
}

/**
 * Create a {@link GitPort} backed by the `git` binary, operating relative to
 * `cwd` (defaults to `process.cwd()`).
 */
export function createGitAdapter(cwd: string = process.cwd()): GitPort {
  const run = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
    return stdout;
  };

  /** Cached repo toplevel (absolute), resolved lazily. */
  let toplevelPromise: Promise<string | null> | null = null;
  const getToplevel = async (): Promise<string | null> => {
    if (!toplevelPromise) {
      toplevelPromise = run(["rev-parse", "--show-toplevel"])
        .then((out) => out.trim() || null)
        .catch(() => null);
    }
    return toplevelPromise;
  };

  return {
    async isRepository(): Promise<boolean> {
      return (await getToplevel()) !== null;
    },

    async currentRef(): Promise<string> {
      try {
        const out = await run(["rev-parse", "--short", "HEAD"]);
        const sha = out.trim();
        if (sha) return sha;
      } catch {
        /* fall through */
      }
      try {
        const branch = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
        return branch.trim();
      } catch {
        return "";
      }
    },

    async diff(scope: DiffScope, baseRef?: string): Promise<FileDiff[]> {
      const toplevel = await getToplevel();
      if (toplevel === null) return [];

      // repo-root-relative (git output) → cwd-relative forward-slash.
      const repoRelToCwdRel = (repoRelPath: string): string => {
        const abs = path.resolve(toplevel, repoRelPath);
        const rel = path.relative(cwd, abs);
        return rel.split(path.sep).join("/");
      };

      const variant = diffArgs(scope, baseRef);
      const nameStatusRaw = await run(["diff", ...variant, "--name-status"]);
      const nameStatus = parseNameStatus(nameStatusRaw);
      if (nameStatus.length === 0) return [];

      // Unified hunks with zero context for tight new-side ranges.
      const unifiedRaw = await run(["diff", ...variant, "--unified=0"]);
      const hunksByPath = parseUnifiedDiff(unifiedRaw);

      return combineDiff(nameStatus, hunksByPath, repoRelToCwdRel);
    },
  };
}
