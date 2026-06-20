/**
 * Best-effort probe (D1): does another process hold `dbPath` open with a command
 * line that looks like a typocop MCP / ladybug server? If so, the augment CLI
 * would contend on the DB lock, so the hook silently skips.
 *
 * Zero-dependency CJS; NOT part of the TS build.
 *
 * Backends:
 * - Linux: cmdline-first procfs scan under /proc — read /proc/<pid>/comm (cheap
 *   prefilter), then /proc/<pid>/cmdline (bounded read), and only for survivors
 *   compare /proc/<pid>/fd/* dev+inode against the target DB. No lsof.
 * - Other Unix (macOS/BSD): lsof + ps, each wrapped in a coreutils `timeout`
 *   when one is available (orphan containment if this hook is SIGKILLed).
 * - Windows: returns false (no probe) — the embedded path on Windows is rare for
 *   this tool and a false-negative only means the augment may briefly contend.
 *
 * Fail matrix: owner found → fail-CLOSED (skip augment). lsof/ps ETIMEDOUT →
 * fail-CLOSED (an unresponsive holder is treated as owning the DB). Other errors
 * → fail-OPEN (no detected owner). Linux budget exhaustion → fail-CLOSED.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function isDebugEnabled() {
  return process.env.TYPOCOP_DEBUG === "1" || process.env.TYPOCOP_DEBUG === "true";
}

/** Does this command line look like a typocop MCP / ladybug server? */
function isTypocopServerCommand(command) {
  const hasServerMode = /(?:^|\s)(mcp|serve|ladybug-server)(?:\s|$)/.test(command);
  const hasTypocop =
    /(?:^|[/\\\s])typocop(?:-mcp|-ladybug-server)?(?:\.cmd)?(?:\s|$)/.test(command) ||
    /node_modules[/\\]typocop[/\\]/.test(command) ||
    /typocop[/\\]dist[/\\]/.test(command);
  return hasServerMode && hasTypocop;
}

// ---- Unix coreutils `timeout` guard (orphan containment) -------------------

let unixGuardTimeoutCache; // undefined=unresolved, string=path, null=none

function passesGuardSelfTest(guard) {
  try {
    const t = spawnSync(guard, ["-k", "1", "1", "/bin/sh", "-c", "exit 42"], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    return !t.error && t.status === 42;
  } catch {
    return false;
  }
}

/**
 * Resolve a coreutils `timeout`/`gtimeout` to wrap lsof/ps with. Unix-only (the
 * self-test spawns /bin/sh). `TYPOCOP_HOOK_TIMEOUT_PATH=disabled` turns it off;
 * any other value is a candidate that must pass the `-k` self-test, else falls
 * through to the built-in list. Memoized per process.
 */
function resolveUnixGuardTimeout() {
  if (unixGuardTimeoutCache !== undefined) return unixGuardTimeoutCache;
  unixGuardTimeoutCache = null;
  const fromEnv = process.env.TYPOCOP_HOOK_TIMEOUT_PATH;
  const trimmed = fromEnv ? String(fromEnv).trim() : "";
  if (trimmed === "disabled") return unixGuardTimeoutCache;
  const candidates = [];
  if (trimmed && fs.existsSync(trimmed)) candidates.push(trimmed);
  for (const builtin of [
    "/usr/bin/timeout",
    "/bin/timeout",
    "/opt/homebrew/bin/gtimeout",
    "/usr/local/bin/gtimeout",
  ]) {
    try {
      if (fs.existsSync(builtin)) candidates.push(builtin);
    } catch {
      /* ignore */
    }
  }
  for (const candidate of candidates) {
    if (passesGuardSelfTest(candidate)) {
      unixGuardTimeoutCache = candidate;
      break;
    }
  }
  return unixGuardTimeoutCache;
}

function spawnGuarded(bin, args, timeoutMs) {
  const guard = process.platform === "win32" ? null : resolveUnixGuardTimeout();
  const budget = String(Math.ceil(timeoutMs / 1000) + 1);
  const [cmd, cmdArgs] = guard
    ? [guard, ["-k", "1", budget, bin, ...args]]
    : [bin, args];
  return spawnSync(cmd, cmdArgs, {
    encoding: "utf-8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
}

// ---- Linux procfs scan -----------------------------------------------------

function getProcRoot() {
  const isTest =
    process.env.VITEST === "true" ||
    process.env.VITEST === "1" ||
    process.env.NODE_ENV === "test";
  if (!isTest) return "/proc";
  const raw = process.env.TYPOCOP_HOOK_PROC_ROOT;
  return raw && String(raw).trim() ? String(raw) : "/proc";
}

const COMM_CANDIDATES = ["node", "typocop", "bun", "deno", "npm", "npx", "MainThread"];
function commLooksLikeServer(comm) {
  const c = comm.trim();
  if (!c) return false;
  for (const name of COMM_CANDIDATES) {
    if (name === c || name.startsWith(c) || c.startsWith(name)) return true;
  }
  return false;
}

function readProcComm(procRoot, pidStr) {
  try {
    return fs
      .readFileSync(path.join(procRoot, pidStr, "comm"), "utf8")
      .replace(/\0+/g, "")
      .trim();
  } catch {
    return "";
  }
}

function readProcCmdline(procRoot, pidStr, cap) {
  let fd;
  try {
    fd = fs.openSync(path.join(procRoot, pidStr, "cmdline"), "r");
  } catch {
    return "";
  }
  try {
    const buf = Buffer.alloc(cap);
    const n = fs.readSync(fd, buf, 0, cap, 0);
    return buf.slice(0, n).toString("utf8").replace(/\0+/g, " ").trim();
  } catch {
    return "";
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

function targetDevIno(dbPathAbs) {
  try {
    const st = fs.statSync(dbPathAbs);
    return { dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

function pidHoldsTarget(procRoot, pidStr, target) {
  const fdDir = path.join(procRoot, pidStr, "fd");
  let entries;
  try {
    entries = fs.readdirSync(fdDir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    try {
      const st = fs.statSync(path.join(fdDir, entry));
      if (st.dev === target.dev && st.ino === target.ino) return true;
    } catch {
      /* fd vanished / unreadable */
    }
  }
  return false;
}

function hasServerOwnerLinux(dbPathAbs, myPid) {
  const procRoot = getProcRoot();
  const target = targetDevIno(dbPathAbs);
  if (!target) return false; // DB file absent → nobody can hold it
  let pids;
  try {
    pids = fs.readdirSync(procRoot).filter((p) => /^\d+$/.test(p));
  } catch {
    return false;
  }
  const cap = 16384;
  const deadline = Date.now() + 2000;
  for (const pidStr of pids) {
    if (Date.now() > deadline) return true; // budget exhausted → fail-closed
    if (Number(pidStr) === myPid) continue;
    const comm = readProcComm(procRoot, pidStr);
    if (!commLooksLikeServer(comm)) continue;
    const cmdline = readProcCmdline(procRoot, pidStr, cap);
    if (!isTypocopServerCommand(cmdline)) continue;
    if (pidHoldsTarget(procRoot, pidStr, target)) return true;
  }
  return false;
}

// ---- Other Unix (macOS/BSD): lsof + ps -------------------------------------

function resolveBinary(tool) {
  const candidates =
    tool === "lsof"
      ? ["/usr/bin/lsof", "/usr/sbin/lsof", "/sbin/lsof", tool]
      : ["/bin/ps", "/usr/bin/ps", tool];
  for (const c of candidates) {
    if (c === tool) return tool;
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return tool;
}

function hasServerOwnerUnix(dbPathAbs, myPid) {
  const lsof = resolveBinary("lsof");
  const r = spawnGuarded(lsof, ["-t", "-w", dbPathAbs], 2000);
  if (r.error) return r.error.code === "ETIMEDOUT"; // unresponsive → fail-closed
  if (r.status !== 0) return false;
  const pids = String(r.stdout || "")
    .split(/\s+/)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0 && n !== myPid);
  if (pids.length === 0) return false;

  const ps = resolveBinary("ps");
  for (const pid of pids) {
    const pr = spawnGuarded(ps, ["-p", String(pid), "-o", "command="], 1000);
    if (pr.error) {
      if (pr.error.code === "ETIMEDOUT") return true;
      continue;
    }
    if (pr.status !== 0) continue;
    if (isTypocopServerCommand(String(pr.stdout || "").trim())) return true;
  }
  return false;
}

/**
 * @param {string} dbPathAbs absolute path to the ladybug DB file
 * @param {number} myPid     this hook process's pid (excluded from the scan)
 * @returns {boolean} true when a server-shaped process holds the DB → skip augment
 */
function hasTypocopDbLockedByServer(dbPathAbs, myPid) {
  try {
    if (!dbPathAbs || !path.isAbsolute(dbPathAbs)) return false;
    if (process.platform === "win32") return false;
    if (process.platform === "linux") return hasServerOwnerLinux(dbPathAbs, myPid);
    return hasServerOwnerUnix(dbPathAbs, myPid);
  } catch (err) {
    if (isDebugEnabled()) {
      process.stderr.write(
        `[typocop hook] db-lock probe error: ${(err && err.message ? err.message : String(err)).slice(0, 200)}\n`,
      );
    }
    return false; // probe failure → fail-open (don't block augment on a broken probe)
  }
}

module.exports = {
  hasTypocopDbLockedByServer,
  isTypocopServerCommand,
  resolveUnixGuardTimeout,
};
