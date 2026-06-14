# Ladybug Server Crash / Unexpected-Stop Resilience Plan

Date: 2026-06-14

Supersedes: none. Focused hardening plan for `src/apps/ladybug-server/` and its
persistence/transport dependencies, covering what happens when the server process
stops in an *unexpected* way (crash, panic, `SIGKILL`, OOM, orchestrator kill,
hung shutdown) rather than a clean `SIGTERM`/`SIGINT`.

## Scope

The connection server (`startConnectionServer`, `src/apps/ladybug-server/server.ts`)
is a long-lived gRPC process that:

1. opens an embedded LadybugDB runtime (acquires a `*.lock` file lock),
2. binds a gRPC server and registers Health/Admin/Graph/Vector services,
3. writes a discovery file (`{pid, url, dbPath, prefix, startedAt}`) clients use to find it,
4. serves requests through a priority scheduler,
5. on `SIGTERM`/`SIGINT` (or idle-timeout, or Admin RPC) drains, shuts down gRPC,
   closes the DB, and removes the discovery file.

The clean-shutdown path is well-built. The gap is everything *off* that path: the
process can die without running it, or get stuck *inside* it. This plan makes the
unexpected-stop paths safe and self-healing.

## Status (re-verified 2026-06-14, after the gRPC message-size plan landed)

The gRPC message-size plan (`2026-06-14-indexing-grpc-message-size-plan.md`) is now
**implemented**. It did **not** touch the shutdown / signal / drain / discovery / lock
paths, so **every failure mode below still holds** (re-confirmed against the current code).
Two things changed that this plan should build on:

- **A config/env limit pattern now exists.** `LadybugServerConfig.grpcMaxMessageBytes`
  (`config/types.ts:66`) is fed from `LADYBUG_GRPC_MAX_MESSAGE_BYTES` via
  `getConfiguredGrpcMaxMessageBytes()` and `deriveRpcPayloadBudgetBytes()`
  (`platform/utils/limits.ts:78–116`). **Phase B should add `shutdownGraceMs`/
  `shutdownHardMs` the same way** (config field + `LADYBUG_SERVER_SHUTDOWN_*` env +
  helper in `limits.ts`) instead of inventing a new mechanism.
- **The default gRPC message ceiling is now 64 MB** (`DEFAULT_GRPC_MAX_MESSAGE_BYTES`,
  applied to server `max_receive`/`max_send` at `server.ts:36–37` and to the client at
  `remote-grpc.ts:34–35`). This is correct for the size error, but it **raises peak
  per-message memory**, so a few concurrent large messages can now OOM the server — an
  OOM is exactly an "unexpected stop," which *reinforces* Phases A and B rather than
  competing with them (see Risk Notes).
- **A halve-on-`RESOURCE_EXHAUSTED` retry pattern now exists** in the export reader
  (`getExportGraphReadPageSize` / page-halving). Phase D's adaptive-retry idea should
  mirror that existing precedent for consistency.

## Current Lifecycle (evidence)

_(Line references refreshed against the post-message-size-plan code.)_

- Signal handling: only `process.once("SIGTERM"|"SIGINT")` (`server.ts:97–102`).
- Shutdown sequence (`server.ts:45–74`): `scheduler.drain()` (`:58`) → `grpcServer.tryShutdown()`
  (`:59–61`) → await drain (`:62`) → `runtime.close()` (`:63`) → `removeDiscoveryFile()` (`:64`).
- `scheduler.drain()` (`scheduler.ts:94–103`) resolves **only** when `inFlight === 0
  && queue.length === 0`; otherwise it awaits a promise with no timeout.
- `runtime.close()` (`runtime.ts:61–80`) → `connection.close()` → native
  `database.close()`; no timeout.
- DB file lock: `proper-lockfile` with `stale: 30000`, `retries: 10` (`file-lock.ts:36–39`);
  released only on graceful `connection.close()` (`connection.ts:71–79`).
- Discovery file: plain write/rm (`discovery.ts`); the file records a `pid` but nothing
  validates liveness on the server side.
- Fatal startup/runtime error: `main.ts:38–40` does `process.exit(1)` with **no cleanup**.
- Clients tolerate stale discovery by treating **health as the source of truth** and will
  `kill(pid, SIGTERM)` a discovered-but-wrong-prefix server (`autostart.ts:93–95`, default
  `killPid` at `autostart.ts:68`).

## Failure Modes When the Process Stops Unexpectedly

### 1. No crash/fatal handlers → orphaned lock + stale discovery + leaked native handle

Only `SIGTERM`/`SIGINT` are handled. On `uncaughtException`, `unhandledRejection`,
`SIGKILL`, OOM, or `process.exit()` elsewhere, none of `removeDiscoveryFile`,
`releaseFileLock`, or `database.close()` runs. Result:

- a **stale discovery file** pointing at a dead `pid`/port,
- an **orphaned `*.lock`** that blocks a new server for up to the 30 s stale window,
- a leaked native DB handle (process is dying, so OS reclaims it — but in-process
  restarts and tests do not).

Impact: high. This is the common real-world failure (crash / kill), and it degrades
the *next* startup.

### 2. Unbounded `drain()` makes graceful shutdown hang forever

`scheduler.drain()` waits indefinitely for `inFlight` to reach 0. A single in-flight
RPC whose underlying Kùzu call never returns (the documented native-teardown / long
query hazard) means `drain()` never resolves → `shutdown()` never completes → the
process ignores `SIGTERM` and hangs until an external `SIGKILL`. That SIGKILL then
triggers failure mode 1. This is the precise mechanism behind the
`Timeout terminating forks worker` artifact seen in the test suite.

Impact: high. Turns a recoverable shutdown into a hard kill with orphaned state.

### 3. `grpcServer.tryShutdown()` has no `forceShutdown` escalation

`tryShutdown` waits for in-flight RPCs to finish and never force-closes. Same hang
class as #2, on the transport layer. There is no bounded deadline after which the
server force-cancels connections.

Impact: high (same root as #2).

### 4. `runtime.close()` (native DB close) has no timeout

Even on a clean drain, `database.close()` can block on native teardown. Nothing
bounds it, so shutdown can still wedge after the scheduler drained.

Impact: medium–high.

### 5. Discovery file is removed *last* and only on success

In `shutdown()` the discovery file is removed *after* `runtime.close()` and inside the
same `try` (`server.ts:63–64`). If `runtime.close()` throws or hangs, the discovery
file is never removed — clients keep finding a server that is shutting down/dead.
The "stop advertising" step should happen *first* and run even on failure.

Impact: medium.

### 6. `main.ts` fatal path skips cleanup

`process.exit(1)` (`main.ts:38–40`) is synchronous and runs no discovery/lock cleanup.
A fatal error after the server started (e.g. `waitForShutdown()` rejecting) leaves
exactly the orphaned state of #1.

Impact: medium.

### 7. Restart-after-crash is blocked by the stale lock window

After a crash the `*.lock` is held until `proper-lockfile`'s 30 s `stale` threshold,
and `acquireFileLock` only `retries: 10` (`file-lock.ts:36–39`). A supervisor that
restarts the server immediately fails to open the DB for up to ~30 s with an opaque
lock error.

Impact: medium. Hurts auto-restart / supervisor scenarios.

### 8. Discovery `pid` reuse hazard on the client side

`autostart.ts:93–95` sends `SIGTERM` to a discovered `pid` when the prefix mismatches.
After a crash the OS may have recycled that pid for an unrelated process, which would
then be signalled. Low frequency, high blast radius.

Impact: low likelihood / high severity — worth a liveness + identity check.

### 9. No persisted exit/crash diagnostics

When the process dies unexpectedly there is no structured "why" record (last error,
in-flight count, uptime). Post-mortem relies on whatever made it to stderr.

Impact: low, but cheap to add and high leverage for operability.

## Improvement Plan

### Phase A: Make unexpected exits safe (best-effort synchronous cleanup)

Add a single `installProcessSafetyNet(cleanup)` wired in `server.ts` that registers,
in addition to the existing `SIGTERM`/`SIGINT`:

- `process.on("uncaughtException")` and `process.on("unhandledRejection")`: log a
  structured fatal event, run **best-effort** cleanup, then exit non-zero.
- `process.on("exit")`: run **synchronous** last-ditch cleanup only (Node forbids async
  work in `exit`). This is where a *synchronous* discovery-file unlink and lock-file
  unlink belong, because they are the only cleanup that can run when the loop is gone.

Concretely:

- Add `removeDiscoveryFileSync(path)` (uses `fs.rmSync(path, {force:true})`) and a
  `releaseFileLockSync(lock)` (best-effort `fs.rmSync(lockPath, {force:true})`) so the
  `exit` handler can always drop the advertisement and the lock.
- Keep the async graceful path as the primary; the sync handlers are the safety net.
- Guard against double-cleanup (a `cleanedUp` flag) so graceful + handler paths don't
  race or double-log.

Acceptance criteria:

- killing the process with an uncaught exception leaves **no** discovery file and **no**
  held lock (verified by a test that throws after start);
- the `exit` handler performs only synchronous I/O;
- no regression to the clean `SIGTERM` path.

### Phase B: Bound the shutdown so it can never hang

Make `shutdown(reason)` deadline-driven:

- Add `shutdownGraceMs` (e.g. 5 000) and `shutdownHardMs` (e.g. 10 000) following the
  **exact pattern the message-size plan just established** for `grpcMaxMessageBytes`: a
  field on `LadybugServerConfig` (`config/types.ts`), an env override
  (`LADYBUG_SERVER_SHUTDOWN_GRACE_MS` / `..._HARD_MS`) read in `ConfigurationManager`, and
  a default constant + `getConfigured…()` helper in `platform/utils/limits.ts` (mirror
  `getConfiguredGrpcMaxMessageBytes`). Thread them through `toLadybugServerConfig` and into
  `shutdown()`.
- `scheduler.drain()` gains a bounded variant: `drain(timeoutMs)` that resolves when
  idle **or** when the deadline elapses, after which it rejects/settles the still-pending
  and in-flight requests with a `ServerShuttingDownError` instead of waiting forever
  (`scheduler.ts:94–103`).
- Race `grpcServer.tryShutdown()` against `shutdownGraceMs`; on timeout call
  `grpcServer.forceShutdown()`.
- Wrap `runtime.close()` in `withTimeoutOr(..., shutdownHardMs)` (the helper already
  exists in `limits.ts`); if it times out, log and proceed to discovery/lock cleanup
  anyway.
- As an absolute backstop, arm an `unref`'d hard-exit timer for `shutdownHardMs` that
  calls `process.exit(1)` if the orderly sequence has not completed — so the process
  always terminates.

Acceptance criteria:

- with a deliberately hung in-flight request, `shutdown()` still completes within ~`shutdownHardMs` and the process exits;
- `forceShutdown` is invoked only after the grace deadline;
- clean shutdowns (no in-flight work) are unaffected and still fast.

### Phase C: Stop advertising first; clean up even on failure

Reorder and harden `shutdown()` (`server.ts:45–74`):

1. set `draining` and **remove the discovery file first** (stop advertising), wrapped so
   its failure never aborts the rest;
2. `tryShutdown` → (grace) → `forceShutdown`;
3. bounded `drain`;
4. bounded `runtime.close()`;
5. release the file lock.

Move discovery removal + lock release into a `finally` so they run whether or not the
DB close succeeds. Health should report `NOT_SERVING` the instant draining starts
(already true via `scheduler.isAcceptingRequests()` → `health.ts:15`), so clients
fail over immediately.

Acceptance criteria:

- if `runtime.close()` throws, the discovery file is still removed and the lock still
  released;
- Health flips to `NOT_SERVING` at the start of shutdown, before the DB closes.

### Phase D: Self-healing startup (reclaim stale lock + stale discovery)

Make a fresh server tolerant of a previous crash:

- On startup, if a discovery file exists, validate it: is the recorded `pid` alive and
  is the advertised port actually accepting? If not, treat the discovery file as stale
  and overwrite it (already mostly the model — make it explicit and server-side).
- For the lock: keep `proper-lockfile`'s `stale` detection but make the window and
  retry/backoff configurable, and surface a clear, actionable error
  ("another server holds <dbPath>; if it crashed, the lock self-clears in N s") instead
  of an opaque failure (`file-lock.ts`).
- Consider writing the owning `pid` into the lock payload so a restart can distinguish
  "really held by a live process" from "stale from my own previous crash".

Acceptance criteria:

- a server started after a simulated crash (stale lock + stale discovery) starts
  successfully without manual cleanup, within a bounded time;
- the lock-contention error message is actionable.

### Phase E: Client-side robustness against stale/recycled discovery

In `autostart.ts`:

- Before `kill(pid, …)` (`autostart.ts:93–95`, default at `:68`), verify the pid is both **alive** and
  actually the typocop server (e.g. compare `startedAt`/`url`, or probe health on the
  advertised url) to avoid signalling a recycled pid (#8).
- Keep "health is the source of truth" but add a bounded retry so a
  server mid-restart is awaited rather than immediately re-spawned (avoid spawn storms
  racing on the lock).

Acceptance criteria:

- a recycled/foreign pid is never signalled;
- concurrent clients do not spawn duplicate servers when one is restarting.

### Phase F: Crash diagnostics

- On any fatal/uncaught path, emit a structured `logServerEvent("error", "fatal_exit",
  {reason, uptimeMs, inFlight, queued, error})` and optionally append a one-line crash
  record next to the discovery file for post-mortem.
- Add the server `pid`, `startedAt`, and uptime to the Health/Admin responses so a
  supervisor can detect flapping.

Acceptance criteria:

- every abnormal exit produces exactly one structured fatal record;
- diagnostics never block or delay the exit.

## Risk Notes

- `process.on("exit")` can only do **synchronous** work — async cleanup there silently
  no-ops. The sync unlink helpers (Phase A) exist precisely for this constraint.
- `forceShutdown` cancels in-flight RPCs; clients must already treat
  `UNAVAILABLE`/cancelled as retryable (verify the remote adapters' retry policy).
- Lowering the lock `stale` window trades faster crash-recovery for a higher chance of
  two processes briefly believing they hold the DB — keep a safety margin and rely on
  pid-liveness rather than only shrinking the timer.
- A hard-exit backstop timer must be `unref`'d so it never *keeps* the process alive,
  and must be the last resort after orderly cleanup, not a substitute for it.
- Changing shutdown ordering touches the integration tests
  (`connection-server.*.integration.test.ts`); update them alongside, and add explicit
  hung-request and crash simulations.
- **The message-size plan raised the gRPC ceiling to 64 MB**, which deliberately allows
  much larger in-flight messages than before. That increases peak memory per request, so
  `maxConcurrency` × 64 MB is now a real OOM ceiling — and an OOM is an unexpected stop
  that lands squarely on failure mode 1. Treat this as extra motivation for Phases A/B
  (safe + bounded exit) and consider documenting/clamping `maxConcurrency` relative to the
  message limit; do not raise the limit further without accounting for it.

## Suggested PR Sequence

1. **Phase A** — process safety net + sync discovery/lock unlink (highest leverage; makes
   crashes safe). Tests: throw-after-start, SIGKILL-equivalent.
2. **Phase B** — bounded drain + `forceShutdown` + `runtime.close` timeout + hard-exit
   backstop (fixes the hang that causes the SIGKILL in the first place).
3. **Phase C** — reorder shutdown (advertise-off first) + `finally` cleanup.
4. **Phase D** — self-healing startup (stale lock/discovery reclaim, actionable errors).
5. **Phase E** — client autostart hardening (pid liveness/identity, restart backoff).
6. **Phase F** — crash diagnostics + Health/Admin uptime.

## First Recommendation

Do Phase A then Phase B. Together they convert the two worst outcomes — "crash leaves
orphaned lock/discovery" and "shutdown hangs until SIGKILL" — into a bounded, self-
cleaning exit. They are also what removes the `Timeout terminating forks worker` class of
hang observed during the test suite. Phases C–F are incremental robustness on top.
