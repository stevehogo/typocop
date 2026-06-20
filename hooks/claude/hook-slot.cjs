/**
 * typocop hook concurrency slots (D1).
 *
 * Caps concurrent `typocop augment` runs PER REPO at HOOK_SLOT_MAX_INFLIGHT
 * using atomic exclusive-create (`wx`) lock files under a per-repo lock dir.
 * Concurrent Claude Code sessions/tool-calls in the same repo therefore fan out
 * at most N augment subprocesses instead of one-per-keystroke.
 *
 * Zero-dependency CJS; NOT part of the TS build (so it can't break
 * dependency-cruiser / ESM resolution).
 *
 * Slot semantics:
 * - `acquireHookSlot(lockBaseDir)` returns a `release()` fn on success, or
 *   `null` when all slots are held (the caller then silently skips — a normal,
 *   non-error outcome).
 * - Dead-owner reaping: a slot whose PID no longer exists (ESRCH) is taken over.
 *   EPERM (cross-user) is treated as alive. Slots older than HOOK_SLOT_STALE_MS
 *   are reaped regardless, as a defense against PID reuse on abandoned slots
 *   (30s >> the ~7s augment timeout, so a healthy run never crosses it).
 * - Fail-CLOSED on lock-dir creation failure (returns null): fail-open would let
 *   N hooks proceed unguarded, reintroducing the fan-out the slot exists to cap.
 */

const fs = require("fs");
const path = require("path");

const HOOK_SLOT_SUBDIR = ".typocop-hook-locks";
const HOOK_SLOT_MAX_INFLIGHT = 3;
const HOOK_SLOT_STALE_MS = 30000;

/**
 * @param {string} lockBaseDir directory under which the slot dir is created
 * @returns {null | (() => void)} release fn, or null if no slot is free
 */
function acquireHookSlot(lockBaseDir) {
  const lockDir = path.join(lockBaseDir, HOOK_SLOT_SUBDIR);
  try {
    fs.mkdirSync(lockDir, { recursive: true });
  } catch {
    return null;
  }

  const myPidStr = String(process.pid);

  for (let slot = 0; slot < HOOK_SLOT_MAX_INFLIGHT; slot++) {
    const slotPath = path.join(lockDir, `slot-${slot}.lock`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(slotPath, myPidStr, { flag: "wx" });
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          try {
            const content = fs.readFileSync(slotPath, "utf-8").trim();
            if (content === myPidStr) fs.unlinkSync(slotPath);
          } catch {
            /* already removed or unreadable */
          }
        };
        process.on("exit", release);
        return release;
      } catch {
        // Slot exists. Inspect mtime + owner via a single fd (no TOCTOU).
        let fd;
        try {
          fd = fs.openSync(slotPath, "r");
        } catch {
          continue; // vanished between EEXIST and open — retry this slot
        }
        let isLive = false;
        let mtimeMs = Date.now();
        try {
          mtimeMs = fs.fstatSync(fd).mtimeMs;
          const buf = Buffer.alloc(32);
          const n = fs.readSync(fd, buf, 0, 32, 0);
          const ownerStr = buf.slice(0, n).toString("utf-8").trim();
          if (ownerStr === "") {
            // Owner created the file but hasn't written its PID yet (microsecond
            // window between wx-create and write) — treat as live.
            isLive = true;
          } else {
            const owner = Number.parseInt(ownerStr, 10);
            if (Number.isFinite(owner) && owner > 0) {
              try {
                process.kill(owner, 0);
                isLive = true;
              } catch (e) {
                // ESRCH = gone → dead. EPERM = alive (other user). Else: assume alive.
                isLive = !(e && e.code === "ESRCH");
              }
            }
          }
        } catch {
          /* unreadable — treat as dead */
        } finally {
          try {
            fs.closeSync(fd);
          } catch {
            /* already closed */
          }
        }
        if (isLive && Date.now() - mtimeMs > HOOK_SLOT_STALE_MS) {
          isLive = false;
        }
        if (isLive) break; // try the next slot
        try {
          fs.unlinkSync(slotPath);
        } catch {
          /* another hook beat us — retry hits EEXIST */
        }
        // loop and retry this slot
      }
    }
  }

  return null;
}

module.exports = {
  HOOK_SLOT_SUBDIR,
  HOOK_SLOT_MAX_INFLIGHT,
  HOOK_SLOT_STALE_MS,
  acquireHookSlot,
};
