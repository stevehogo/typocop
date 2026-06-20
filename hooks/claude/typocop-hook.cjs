#!/usr/bin/env node
/**
 * typocop Claude Code hook (D1 — flagship).
 *
 * PreToolUse — intercepts the agent's Grep/Glob/Bash searches and injects graph
 * context from the typocop index via a fast, keyword-only, FAIL-SILENT path:
 *
 *   stdin JSON → extract search pattern → acquire a per-repo concurrency slot →
 *   probe whether a typocop/ladybug server already owns the DB (skip if so) →
 *   spawnSync `typocop augment <pattern>` with a hard timeout → scrape the
 *   `[typocop]`-marked block off stderr → emit
 *   {"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":…}}
 *   ONLY when non-empty.
 *
 * Every skip path (no pattern, slots saturated, server owns DB, CLI failure,
 * empty output) produces EMPTY stdout and exit 0 — a normal, silent no-op.
 * Diagnostics go to the hook's own stderr behind TYPOCOP_DEBUG.
 *
 * Zero-dependency CJS; NOT part of the TS build (so it can't break
 * dependency-cruiser / ESM resolution).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { acquireHookSlot } = require("./hook-slot.cjs");
const { hasTypocopDbLockedByServer } = require("./hook-db-lock-probe.cjs");

function isDebugEnabled() {
  return process.env.TYPOCOP_DEBUG === "1" || process.env.TYPOCOP_DEBUG === "true";
}

function debug(msg) {
  if (isDebugEnabled()) process.stderr.write(`[typocop hook] ${msg}\n`);
}

/** Read + parse stdin JSON synchronously; `{}` on any error. */
function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Extract a search pattern from the tool input. Ported from GitNexus
 * `extractPattern`:
 *  - Grep → `tool_input.pattern`
 *  - Glob → first ≥3-char identifier-ish segment of the glob
 *  - Bash → the first non-flag positional after an `rg`/`grep` invocation
 */
function extractPattern(toolName, toolInput) {
  if (toolName === "Grep") {
    return toolInput.pattern || null;
  }

  if (toolName === "Glob") {
    const raw = toolInput.pattern || "";
    const match = raw.match(/[*/]([a-zA-Z][a-zA-Z0-9_-]{2,})/);
    return match ? match[1] : null;
  }

  if (toolName === "Bash") {
    const cmd = toolInput.command || "";
    if (!/\brg\b|\bgrep\b/.test(cmd)) return null;

    const tokens = cmd.split(/\s+/);
    let foundCmd = false;
    let skipNext = false;
    const flagsWithValues = new Set([
      "-e", "-f", "-m", "-A", "-B", "-C", "-g", "--glob",
      "-t", "--type", "--include", "--exclude",
    ]);

    for (const token of tokens) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (!foundCmd) {
        if (/\brg$|\bgrep$/.test(token)) foundCmd = true;
        continue;
      }
      if (token.startsWith("-")) {
        if (flagsWithValues.has(token)) skipNext = true;
        continue;
      }
      const cleaned = token.replace(/['"]/g, "");
      return cleaned.length >= 3 ? cleaned : null;
    }
    return null;
  }

  return null;
}

/** Default prefix used by typocop config when TYPOCOP_PREFIX is unset. */
const DEFAULT_PREFIX = "tpc_";

/**
 * Resolve the ladybug DB path the same way the typocop config does:
 * `LADYBUGDB_PATH` wins; otherwise `~/.typocop/<prefix>/db.ladybug` where
 * `<prefix>` is `TYPOCOP_PREFIX` (default `tpc_`).
 */
function resolveDbPath() {
  const explicit = process.env.LADYBUGDB_PATH;
  if (explicit && String(explicit).trim()) return path.resolve(String(explicit).trim());
  const prefix = process.env.TYPOCOP_PREFIX && String(process.env.TYPOCOP_PREFIX).trim()
    ? String(process.env.TYPOCOP_PREFIX).trim()
    : DEFAULT_PREFIX;
  return path.join(os.homedir(), ".typocop", prefix, "db.ladybug");
}

/**
 * The directory used both as the per-repo slot base AND as a stable, writable
 * location independent of cwd. We use the DB's parent dir so concurrent
 * sessions against the same index share the same slots.
 */
function resolveLockBaseDir(dbPath) {
  return path.dirname(dbPath);
}

/** Resolve the CLI entrypoint: env override, packaged dist, or `typocop` on PATH. */
function resolveCli() {
  const fromEnv = process.env.TYPOCOP_HOOK_CLI_PATH;
  if (fromEnv && String(fromEnv).trim() && fs.existsSync(String(fromEnv).trim())) {
    return { node: true, path: String(fromEnv).trim() };
  }
  // hooks/claude/ → ../../dist/apps/cli/main.js inside the installed package.
  const packaged = path.resolve(__dirname, "..", "..", "dist", "apps", "cli", "main.js");
  if (fs.existsSync(packaged)) return { node: true, path: packaged };
  try {
    const resolved = require.resolve("typocop/dist/apps/cli/main.js");
    return { node: true, path: resolved };
  } catch {
    return { node: false, path: "typocop" }; // rely on PATH
  }
}

/** Scrape the `[typocop]`-marked block from stderr; '' when no marker. */
function scrapeAugmentBlock(stderr) {
  const out = (stderr || "").trim();
  const idx = out.indexOf("[typocop]");
  if (isDebugEnabled() && out.length > 0) {
    const discarded = idx === -1 ? out : out.slice(0, idx).trim();
    if (discarded.length > 0) {
      process.stderr.write(`[typocop hook] augment stderr discarded prefix:\n${discarded}\n`);
    }
  }
  if (idx === -1) return "";
  // Drop the marker token itself; keep the human-readable body.
  return out.slice(idx).replace(/^\[typocop\]\s*/, "").trim();
}

/** Spawn `typocop augment -- <pattern>` with a hard timeout; return stderr. */
function runAugment(pattern, cwd, timeoutMs) {
  const cli = resolveCli();
  const args = cli.node
    ? [cli.path, "augment", "--", pattern]
    : ["augment", "--", pattern];
  const bin = cli.node ? process.execPath : cli.path;
  return spawnSync(bin, args, {
    encoding: "utf-8",
    timeout: timeoutMs,
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function sendResponse(message) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: message,
      },
    }),
  );
}

function handlePreToolUse(input) {
  const cwd = input.cwd && path.isAbsolute(input.cwd) ? input.cwd : process.cwd();
  const toolName = input.tool_name || "";
  if (toolName !== "Grep" && toolName !== "Glob" && toolName !== "Bash") return;

  const pattern = extractPattern(toolName, input.tool_input || {});
  if (!pattern || pattern.length < 3) return;

  const dbPath = resolveDbPath();
  const lockBaseDir = resolveLockBaseDir(dbPath);

  // Acquire the per-repo slot BEFORE the DB-owner probe — the probe itself
  // spawns lsof/ps (on non-Linux), so it must be bounded by the same cap.
  const release = acquireHookSlot(lockBaseDir);
  if (!release) {
    debug("augment skipped: hook slots saturated");
    return;
  }

  let result = "";
  try {
    if (hasTypocopDbLockedByServer(dbPath, process.pid)) {
      debug("augment skipped: server owns DB");
      return;
    }
    const child = runAugment(pattern, cwd, 7000);
    if (!child.error && child.status === 0) {
      result = scrapeAugmentBlock(child.stderr || "");
    } else if (child.error) {
      debug(`augment spawn error: ${String(child.error.code || child.error.message || "")}`);
    }
  } catch (err) {
    debug(`augment failed: ${(err && err.message ? err.message : String(err)).slice(0, 200)}`);
  } finally {
    release();
  }

  if (result) sendResponse(result);
}

function main() {
  try {
    const input = readInput();
    if ((input.hook_event_name || "") === "PreToolUse") {
      handlePreToolUse(input);
    }
  } catch (err) {
    debug(`hook error: ${(err && err.message ? err.message : String(err)).slice(0, 200)}`);
  }
}

main();
