/**
 * D1 — typocop-hook.cjs integration tests.
 *
 * Spawns the real hook script over crafted stdin (Grep / Glob / Bash variants)
 * with a STUB CLI (so no real DB is touched) and asserts:
 *  - the pattern is extracted and the augment block is emitted as
 *    {"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":…}}
 *  - non-search tools and unknown patterns emit EMPTY stdout, exit 0
 *  - a saturated slot set → EMPTY stdout, exit 0 (silent skip)
 *  - a server-owned DB → EMPTY stdout, exit 0 (silent skip)
 *
 * The hook is plain CJS (not in the TS build); we exercise it as a subprocess.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const hookPath = path.join(repoRoot, "hooks", "claude", "typocop-hook.cjs");

let tmpDir: string;
let dbPath: string;
let stubCliPath: string;

/** A stub `typocop` CLI: prints a marked block to stderr, exits 0. */
const STUB_CLI = `#!/usr/bin/env node
const args = process.argv.slice(2);
// args: ["augment", "--", "<pattern>"]
const pattern = args[args.length - 1] || "";
process.stderr.write("some native lib noise on stderr\\n");
process.stderr.write("[typocop] Graph context for \\"" + pattern + "\\":\\n  " + pattern + "\\n    called by: someCaller\\n");
process.exit(0);
`;

/** A stub CLI that emits NOTHING (no marker) — augment found no context. */
const STUB_CLI_EMPTY = `#!/usr/bin/env node
process.exit(0);
`;

function runHook(
  input: unknown,
  env: Record<string, string> = {},
  cliBody: string = STUB_CLI,
): { stdout: string; status: number | null } {
  fs.writeFileSync(stubCliPath, cliBody, { mode: 0o755 });
  const r = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    env: {
      ...process.env,
      LADYBUGDB_PATH: dbPath,
      TYPOCOP_HOOK_CLI_PATH: stubCliPath,
      ...env,
    },
  });
  return { stdout: r.stdout || "", status: r.status };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "typocop-hook-"));
  dbPath = path.join(tmpDir, "db.ladybug");
  fs.writeFileSync(dbPath, "stub"); // so the probe can stat it
  stubCliPath = path.join(tmpDir, "stub-cli.cjs");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("typocop-hook.cjs (PreToolUse)", () => {
  it("extracts a Grep pattern and emits additionalContext", () => {
    const { stdout, status } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Grep",
      tool_input: { pattern: "getUser" },
      cwd: repoRoot,
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("getUser");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("called by: someCaller");
    // The marker is stripped from the injected context.
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain("[typocop]");
    // Native-lib stderr noise before the marker is discarded.
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain("native lib noise");
  });

  it("extracts a Glob identifier segment", () => {
    const { stdout, status } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Glob",
      tool_input: { pattern: "src/**/userService.ts" },
      cwd: repoRoot,
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("userService");
  });

  it("extracts the search term from a Bash rg command", () => {
    const { stdout, status } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rg -n 'handleLogin' src/" },
      cwd: repoRoot,
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("handleLogin");
  });

  it("emits empty stdout for a non-search tool", () => {
    const { stdout, status } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "x.ts" },
      cwd: repoRoot,
    });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  it("emits empty stdout for a Bash command that is not a search", () => {
    const { stdout, status } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      cwd: repoRoot,
    });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  it("emits empty stdout for too-short a pattern", () => {
    const { stdout, status } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Grep",
      tool_input: { pattern: "ab" },
      cwd: repoRoot,
    });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  it("emits empty stdout when the CLI produces no marked block", () => {
    const { stdout, status } = runHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Grep",
        tool_input: { pattern: "getUser" },
        cwd: repoRoot,
      },
      {},
      STUB_CLI_EMPTY,
    );
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  it("silently skips (empty stdout, exit 0) when all slots are saturated", () => {
    // Pre-fill all 3 slots with THIS (alive) process's pid so the hook can't
    // acquire one. Slot base dir == dirname(dbPath).
    const lockDir = path.join(path.dirname(dbPath), ".typocop-hook-locks");
    fs.mkdirSync(lockDir, { recursive: true });
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(lockDir, `slot-${i}.lock`), String(process.pid));
    }
    const { stdout, status } = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Grep",
      tool_input: { pattern: "getUser" },
      cwd: repoRoot,
    });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  it("silently skips (empty stdout, exit 0) when a server owns the DB", () => {
    // Linux: build a fake procfs tree the probe scans (test-gated via NODE_ENV).
    if (process.platform !== "linux") return;

    const procRoot = path.join(tmpDir, "proc");
    const serverPid = "424242";
    const procPidDir = path.join(procRoot, serverPid);
    fs.mkdirSync(path.join(procPidDir, "fd"), { recursive: true });
    fs.writeFileSync(path.join(procPidDir, "comm"), "node\n");
    fs.writeFileSync(
      path.join(procPidDir, "cmdline"),
      ["node", "/opt/app/node_modules/typocop/dist/apps/mcp-server/main.js", "mcp"].join("\0"),
    );
    // fd/3 → a hardlink to dbPath so dev+ino match the probe's target.
    fs.linkSync(dbPath, path.join(procPidDir, "fd", "3"));

    const { stdout, status } = runHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Grep",
        tool_input: { pattern: "getUser" },
        cwd: repoRoot,
      },
      { NODE_ENV: "test", TYPOCOP_HOOK_PROC_ROOT: procRoot },
    );
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("");
  });
});
