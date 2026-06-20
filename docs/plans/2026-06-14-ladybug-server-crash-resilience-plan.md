# Ladybug Server Crash / Unexpected-Stop Resilience Plan

Date: 2026-06-14
Last updated: 2026-06-16 (status reconciled against the implementation)

Supersedes: none. Focused hardening plan for `src/apps/ladybug-server/` and its
persistence/transport dependencies, covering what happens when the server process
stops in an *unexpected* way (crash, panic, `SIGKILL`, OOM, orchestrator kill,
hung shutdown) rather than a clean `SIGTERM`/`SIGINT`.

## Implementation Status (updated 2026-06-16): ✅ COMPLETE

**All six phases (A–F) are implemented, tested, and committed** (commit `ad455bb`,
branch `feature/refactor-code-base`). All nine failure modes documented below are now
resolved. This was verified file-by-file against the current code on 2026-06-16; the
sections below have been annotated with status and corrected line references.

| Phase | Theme | Status | Primary evidence |
| --- | --- | --- | --- |
| A | Safe unexpected exits (process safety net + sync cleanup) | ✅ Done | `safety-net.ts`, `server.ts:75-97,236-253`, `discovery.ts:40`, `file-lock.ts:150` |
| B | Bounded, non-hanging shutdown | ✅ Done | `server.ts:99-196,377-401`, `scheduler.ts:113-177`, `limits.ts:190-223` |
| C | Advertise-off first; cleanup in `finally` | ✅ Done | `server.ts:109,135-137,182-192`, `health.ts:26` |
| D | Self-healing startup (stale lock + discovery reclaim) | ✅ Done | `server.ts:275,425-457`, `file-lock.ts:86-126`, `errors.ts:30-69` |
| E | Client robustness vs stale/recycled discovery | ✅ Done | `autostart.ts:108,200-224,233-277` |
| F | Crash diagnostics | ✅ Done | `safety-net.ts:86-118`, `server.ts:199-253`, `health.ts:26-34`, `admin.ts:22-24`, `proto/ladybug_connection.proto` |

Test coverage: dedicated suites `safety-net.test.ts`, `server.shutdown.test.ts`,
`server.reclaim.test.ts`, plus extended `scheduler.test.ts`, `file-lock.test.ts`,
`connection.test.ts`, `autostart.test.ts`, and `autostart.integration.test.ts`. The full
suite passes (1354 passed / 3 skipped at the time the work landed); `tsc` and
`dependency-cruiser` are clean.

The non-blocking follow-ups (test-coverage gaps + one dead-code helper) have since been
**resolved** (2026-06-16) — see [Follow-ups (resolved 2026-06-16)](#follow-ups-resolved-2026-06-16).

## Scope

The connection server (`startConnectionServer`, `src/apps/ladybug-server/server.ts`)
is a long-lived gRPC process that:

1. opens an embedded LadybugDB runtime (acquires a `*.lock` file lock),
2. binds a gRPC server and registers Health/Admin/Graph/Vector services,
3. writes a discovery file (`{pid, url, dbPath, prefix, startedAt}`) clients use to find it,
4. serves requests through a priority scheduler,
5. on `SIGTERM`/`SIGINT` (or idle-timeout, or Admin RPC) drains, shuts down gRPC,
   closes the DB, and removes the discovery file.

The clean-shutdown path was already well-built. The gap this plan addressed was
everything *off* that path: the process could die without running it, or get stuck
*inside* it. The plan made the unexpected-stop paths safe and self-healing — and that
work is now landed.

## Background (historical — 2026-06-14, superseded by the implementation)

> **Superseded.** This snapshot recorded the *pre-hardening* state. It claimed "every
> failure mode below still holds" — that is no longer true: as of commit `ad455bb` all
> nine modes are resolved. Kept for context on what motivated the work.

The gRPC message-size plan (`2026-06-14-indexing-grpc-message-size-plan.md`) was
**implemented** first. It did **not** touch the shutdown / signal / drain / discovery /
lock paths, so at the time every failure mode below still held. Two things it changed
that this plan built on:

- **A config/env limit pattern existed.** `LadybugServerConfig.grpcMaxMessageBytes`
  (now `src/platform/config/types.ts:66`) is fed from `LADYBUG_GRPC_MAX_MESSAGE_BYTES`.
  Phase B followed this pattern for `shutdownGraceMs`/`shutdownHardMs`. ✅ Done — see
  `src/platform/config/types.ts:71-74` and `src/platform/utils/limits.ts:190-223`.
- **The default gRPC message ceiling is 64 MB** (`DEFAULT_GRPC_MAX_MESSAGE_BYTES`). This
  raises peak per-message memory, so a few concurrent large messages can OOM the server —
  an OOM is an "unexpected stop," which reinforced Phases A and B (see Risk Notes).
- **A halve-on-`RESOURCE_EXHAUSTED` retry pattern existed** in the export reader. Phase D's
  adaptive-retry idea mirrored that precedent for consistency.

## Lifecycle (updated 2026-06-16 — post-hardening)

_(This section previously described the unhardened paths with line refs that are now
stale. It has been rewritten to the current, hardened behavior. The original
unhardened lifecycle is recoverable from git history before commit `ad455bb`.)_

- **Signal & fatal handling:** `process.once("SIGTERM"|"SIGINT")` (`server.ts:226-231`)
  **plus** `installProcessSafetyNet()` (`server.ts:236-253`) which registers
  `uncaughtException` / `unhandledRejection` / `exit` handlers (`safety-net.ts:160-162`).
  Unexpected exits are now handled, not just clean signals.
- **Shutdown sequence (`server.ts:99-196`):** `scheduler.markDraining()` (`:109`) →
  arm unref'd hard-exit backstop (`:118-130`) → **remove discovery file first** (`:135-137`,
  wrapped in `.catch`) → `raceGrpcShutdown` (`tryShutdown` raced vs `shutdownGraceMs`, then
  `forceShutdown`, `:142`/`:377-401`) → bounded `scheduler.drain(graceMs)` (`:141`/`:145`) →
  `withTimeoutOr(runtime.close(), shutdownHardMs)` (`:159-170`) → `cleanupAsync` (discovery
  + lock release) in a `finally` (`:182-192`).
- **Bounded drain:** `scheduler.drain(timeoutMs?)` (`scheduler.ts:113-134`) resolves when
  idle **or** when the deadline elapses, at which point `settlePendingForDrain()`
  (`scheduler.ts:143-177`) settles queued and in-flight requests with a
  `ServerShuttingDownError`. The old unbounded wait survives only as the
  `timeoutMs === undefined` backward-compat branch.
- **Bounded native close:** `runtime.close()` (`runtime.ts:61-80`) still has no *internal*
  timeout, but is bounded externally by the `withTimeoutOr(..., shutdownHardMs)` wrapper at
  `server.ts:159-170`.
- **DB file lock:** `proper-lockfile` with `stale`/`retries` sourced from
  `getConfiguredDbLockStaleMs()` / `getConfiguredDbLockRetries()` (defaults 30000 / 10 in
  `limits.ts:233`/`:239`, env-overridable via `LADYBUG_DB_LOCK_STALE_MS` / `_RETRIES`),
  applied in `file-lock.ts:91-92,106`. The owning `pid` is written into the lock payload
  (`file-lock.ts:119-123`). Released on graceful `connection.close()`
  (`connection.ts:71-83,105-117`) **and** synchronously via `releaseFileLockSync()`
  (`file-lock.ts:150-156`) from the exit handler / startup-failure path.
- **Discovery file:** `write` / `rm`, plus `readDiscoveryFile` (`discovery.ts:18-29`) and
  `removeDiscoveryFileSync` (`discovery.ts:40-46`). On startup the server validates an
  existing discovery file's `pid` liveness and reclaims it if stale via
  `reclaimStaleDiscovery` (`server.ts:275,425-457`).
- **Fatal startup/runtime error:** `main.ts` runs `server.shutdown("fatal")` before
  rethrowing (`main.ts:35-42`) and logs `fatal_exit` before `process.exit(1)`
  (`main.ts:51-54`); `startConnectionServer` also has a startup-failure catch
  (`server.ts:312-322`) that disposes the safety net and runs `runtime.close()` +
  synchronous cleanup. No longer a bare `process.exit(1)`.
- **Client discovery handling:** clients still treat health as the source of truth, but
  before signalling a discovered-but-wrong-prefix `pid` they verify it is **alive and
  identity-confirmed** via `isOurLiveServer` (`autostart.ts:108,200-224`) and await a
  restarting server with bounded backoff (`autostart.ts:233-277`).

## Failure Modes When the Process Stops Unexpectedly

> **All nine resolved (2026-06-16).** Each mode below is annotated with the fix and its
> location. Descriptions retain the original problem statement for context.

### 1. No crash/fatal handlers → orphaned lock + stale discovery + leaked native handle

Originally only `SIGTERM`/`SIGINT` were handled. On `uncaughtException`,
`unhandledRejection`, `SIGKILL`, OOM, or `process.exit()` elsewhere, none of
`removeDiscoveryFile`, `releaseFileLock`, or `database.close()` ran — leaving a stale
discovery file, an orphaned `*.lock` (blocking a new server for up to the 30 s stale
window), and a leaked native handle on in-process restarts/tests.

Impact: high. **✅ Resolved (Phase A):** `installProcessSafetyNet` (`server.ts:236-253`)
registers `uncaughtException`/`unhandledRejection`/`exit`; the `exit` handler runs
synchronous `removeDiscoveryFileSync` + `releaseFileLockSync` (`server.ts:77-84`).

### 2. Unbounded `drain()` makes graceful shutdown hang forever

`scheduler.drain()` waited indefinitely for `inFlight` to reach 0. A single in-flight
RPC whose underlying Kùzu call never returned meant `drain()` never resolved → shutdown
never completed → the process hung until an external `SIGKILL` (which then triggered
mode 1). This was the precise mechanism behind the `Timeout terminating forks worker`
test artifact.

Impact: high. **✅ Resolved (Phase B):** bounded `scheduler.drain(timeoutMs)`
(`scheduler.ts:113-134`) settles queued + in-flight with `ServerShuttingDownError` on the
deadline (`settlePendingForDrain`, `scheduler.ts:143-177`); called with
`config.shutdownGraceMs` at `server.ts:141`.

### 3. `grpcServer.tryShutdown()` has no `forceShutdown` escalation

`tryShutdown` waited for in-flight RPCs and never force-closed — the same hang class as
#2 at the transport layer.

Impact: high. **✅ Resolved (Phase B):** `raceGrpcShutdown` (`server.ts:377-401`) races
`tryShutdown` against `shutdownGraceMs` and escalates to `grpcServer.forceShutdown()` on
timeout (logged `grpc_force_shutdown`); invoked at `server.ts:142`.

### 4. `runtime.close()` (native DB close) has no timeout

Even on a clean drain, `database.close()` could block on native teardown with nothing
bounding it.

Impact: medium–high. **✅ Resolved (Phase B):** the caller wraps it in
`withTimeoutOr(runtime.close(), shutdownHardMs)` (`server.ts:159-170`); timeout and error
are logged (`runtime_close_timeout` / `runtime_close_failed`) and swallowed so cleanup
proceeds.

### 5. Discovery file is removed *last* and only on success

`shutdown()` removed the discovery file *after* `runtime.close()` inside the same `try`,
so a throwing/hanging close left the file behind and clients kept finding a dead server.

Impact: medium. **✅ Resolved (Phase C):** discovery is removed **first**
(`server.ts:135-137`, wrapped in `.catch`) **and** again in the `finally` via
`cleanupAsync` (`server.ts:182-192`), so it is dropped regardless of the close outcome.

### 6. `main.ts` fatal path skips cleanup

`process.exit(1)` was synchronous and ran no discovery/lock cleanup, leaving the orphaned
state of #1 after a fatal post-start error.

Impact: medium. **✅ Resolved (Phase A/F):** `main.ts:35-42` runs `server.shutdown("fatal")`
before rethrow; `main.ts:51-54` logs `fatal_exit` before exit; `server.ts:312-322` adds a
startup-failure catch; and the safety-net `exit` handler performs synchronous cleanup.

### 7. Restart-after-crash is blocked by the stale lock window

After a crash the `*.lock` was held until `proper-lockfile`'s 30 s `stale` threshold, and
`acquireFileLock` only retried 10 times, so an immediate supervisor restart failed for up
to ~30 s with an opaque lock error.

Impact: medium. **✅ Resolved (Phase A+D):** a crash now drops the lock synchronously
(`releaseFileLockSync`, #1), so the stale window is rarely needed; the stale/retry window
is configurable (`LADYBUG_DB_LOCK_STALE_MS`/`_RETRIES`, `file-lock.ts:91-92`,
`limits.ts:233-262`); and the opaque error is replaced by an actionable
`DatabaseLockedError` (`errors.ts:30-69`) that names the `dbPath`, the self-clear window,
and whether the holder is live vs crashed.

### 8. Discovery `pid` reuse hazard on the client side

When the prefix mismatched, the client sent `SIGTERM` to a discovered `pid` — but after a
crash the OS may have recycled that pid for an unrelated process.

Impact: low likelihood / high severity. **✅ Resolved (Phase E):** the kill
(`autostart.ts:108-122`) is gated by `isOurLiveServer` (`autostart.ts:200-224`), which
requires both pid liveness (`process.kill(pid, 0)`) **and** a successful health probe on
the advertised url before signalling; otherwise it skips the kill and falls through to a
normal spawn.

### 9. No persisted exit/crash diagnostics

When the process died unexpectedly there was no structured "why" record.

Impact: low, but cheap to add. **✅ Resolved (Phase F):** `recordFatal`
(`safety-net.ts:87-118`) emits exactly one structured `fatal_exit`
`{reason, uptimeMs, inFlight, queued, error}` (guarded by `firedFatal`) and best-effort
writes a synchronous one-line crash record to `${discoveryPath}.crash`
(`server.ts:250-252`); `pid`/`startedAt`/`uptimeMs` are exposed on Health
(`health.ts:26-34`) and Admin `GetMetrics` (`admin.ts:22-24`).

## Improvement Plan

> **All phases below are implemented.** Each is annotated with its delivered state and any
> residual caveat. Original design intent is retained for the record.

### Phase A: Make unexpected exits safe (best-effort synchronous cleanup) — ✅ Done

A single `installProcessSafetyNet(options)` (`safety-net.ts:78`) wired in `server.ts:236`
registers, in addition to the existing `SIGTERM`/`SIGINT`:

- `process.on("uncaughtException")` / `process.on("unhandledRejection")`: log a structured
  fatal event, run **best-effort** async cleanup (`cleanupAsync` → `shutdown("fatal")`),
  then exit non-zero.
- `process.on("exit")`: run **synchronous** last-ditch cleanup only — a synchronous
  discovery-file unlink and lock-file unlink, the only cleanup that can run when the loop
  is gone.

Delivered:

- `removeDiscoveryFileSync(path)` (`discovery.ts:40`, `fs.rmSync(path, {force:true})`) and
  `releaseFileLockSync(lockPath)` (`file-lock.ts:150`, `fs.rmSync` on the proper-lockfile
  dir). _Note: the helper takes a path string, not a `FileLock` object, because the server
  does not hold the object._
- A shared `cleanedUp` flag (`server.ts:75-97`) guards graceful + handler paths against
  double cleanup/log.

Acceptance criteria — met:

- killing the process via an uncaught exception runs cleanup that removes the discovery
  file and lock — ✅ wiring verified, **and now covered against the real filesystem** by
  `safety-net.crash-cleanup.test.ts` (creates a real discovery file + real lock, fires the
  `exit`/`uncaughtException` handlers via the injectable fake `proc`/`exit`, asserts both
  are gone from disk). Earlier coverage was unit-level only (`safety-net.test.ts`,
  `server.shutdown.test.ts` mocked unlinks).
- the `exit` handler performs only synchronous I/O — ✅ (`safety-net.ts:146-158`,
  `safety-net.test.ts`).
- no regression to the clean `SIGTERM` path — ✅ (`server.ts:226-231`, `server.test.ts`,
  `server.shutdown.test.ts` fast-clean-shutdown case).

### Phase B: Bound the shutdown so it can never hang — ✅ Done

`shutdown(reason)` is deadline-driven (`server.ts:99-196`):

- `shutdownGraceMs` (default 5 000) and `shutdownHardMs` (default 10 000) follow the
  message-size plan's `grpcMaxMessageBytes` pattern: fields on `LadybugServerConfig`
  (`config/types.ts:71-74`), env overrides `LADYBUG_SERVER_SHUTDOWN_GRACE_MS` / `_HARD_MS`
  read in `ConfigurationManager` (`configuration-manager.ts:296-305`), default constants in
  `limits.ts:190-203`, threaded through `toLadybugServerConfig` (`server.ts:338-339`) into
  `shutdown()`.
  - **Resolved 2026-06-16:** the `getConfiguredShutdownGraceMs/HardMs` helpers were
    *unused in production* (`ConfigurationManager` reads the env directly via
    `parsePositiveInt`) and have been **deleted** along with their tests; the `DEFAULT_*` /
    `*_ENV` constants the manager uses are retained.
- `scheduler.drain(timeoutMs)` (`scheduler.ts:113-134`) resolves when idle or on deadline,
  settling pending + in-flight with `ServerShuttingDownError` (`settlePendingForDrain`).
- `raceGrpcShutdown` (`server.ts:377-401`) races `tryShutdown()` against `shutdownGraceMs`
  then calls `forceShutdown()`.
- `runtime.close()` wrapped in `withTimeoutOr(..., shutdownHardMs)` (`server.ts:159-170`,
  helper at `limits.ts:424-453`).
- an `unref`'d hard-exit backstop timer (`server.ts:118-130`,
  `shutdownGraceMs + shutdownHardMs + 1000`) calls `process.exit(1)` if the orderly
  sequence has not completed.

Acceptance criteria — met:

- a hung in-flight request still lets `shutdown()` complete within ~`shutdownHardMs` and
  the process exits — ✅ (`server.shutdown.test.ts` hung-close case; `scheduler.test.ts`).
- `forceShutdown` invoked only after the grace deadline — ✅ (`server.shutdown.test.ts`
  escalation + clean-shutdown-never-force cases).
- clean shutdowns unaffected/fast — ✅.

### Phase C: Stop advertising first; clean up even on failure — ✅ Done

`shutdown()` (`server.ts:99-196`) is reordered and hardened:

1. `scheduler.markDraining()` (`:109`) and **remove the discovery file first** (`:135-137`,
   wrapped so its failure never aborts the rest);
2. `tryShutdown` → (grace) → `forceShutdown` (`:142`);
3. bounded `drain` (`:141`/`:145`);
4. bounded `runtime.close()` (`:159-170`);
5. release the file lock.

Discovery removal + lock release run in `cleanupAsync` inside a `finally`
(`server.ts:182-192`) so they execute whether or not the DB close succeeds. Health reports
`NOT_SERVING` the instant draining starts via `scheduler.isAcceptingRequests()`
(`health.ts:26`).

Acceptance criteria — met:

- if `runtime.close()` throws, discovery is still removed and the lock still released — ✅
  (`server.shutdown.test.ts` reject-close + hang-close cases).
- Health flips to `NOT_SERVING` at the start of shutdown, before the DB closes — ✅
  (`markDraining` is the first action; `health.ts:26`).

### Phase D: Self-healing startup (reclaim stale lock + stale discovery) — ✅ Done

A fresh server tolerates a previous crash:

- On startup, `reclaimStaleDiscovery` (`server.ts:275,425-457`) reads an existing discovery
  file and, if the recorded `pid` is not alive, treats it as stale and overwrites it
  (logging `discovery_reclaimed_stale`); a live-pid record logs
  `discovery_overwrite_live_pid` and proceeds; it never throws.
- The lock `stale` window and retries are configurable
  (`LADYBUG_DB_LOCK_STALE_MS`/`_RETRIES`, `limits.ts:226-262`, `file-lock.ts:91-92`), and an
  actionable `DatabaseLockedError` (`errors.ts:30-69`) replaces the opaque failure — naming
  the `dbPath`, the self-clear window, and live-vs-crashed holder. It propagates unwrapped
  from `connection.ts:57` (`connection.test.ts:192`).
- The owning `pid` is written into the lock payload (`file-lock.ts:119-123`) and read back
  on contention to distinguish a live holder from a stale one.

Acceptance criteria — met (one caveat):

- a server started after a simulated crash starts without manual cleanup — ✅ mechanisms
  wired and unit-tested (`server.reclaim.test.ts`, `file-lock.test.ts`), **and now covered
  end-to-end** by `connection-server.crash-recovery.integration.test.ts` (boots a real
  server over a planted crashed-holder lock + dead-pid discovery and asserts self-heal in
  < 5 s, with the discovery overwritten and Health `SERVING`).
- the lock-contention error is actionable — ✅ (`file-lock.test.ts`).

### Phase E: Client-side robustness against stale/recycled discovery — ✅ Done

In `autostart.ts`:

- Before `kill(pid, …)` (`autostart.ts:108-122`), `isOurLiveServer` (`:200-224`) verifies the
  pid is **alive** (`isPidAliveFn`, default `process.kill(pid, 0)` at `:330-341`) **and**
  identity-confirmed via a health probe on the advertised url, so a recycled/foreign pid is
  never signalled.
- Health remains the source of truth, with a bounded `awaitRestartingServer` (`:233-277`,
  `RESTART_AWAIT_DEADLINE_MS = 3000`) that awaits a prefix-matching, live-owner restart with
  exponential backoff before re-spawning — avoiding spawn storms racing on the lock.

Acceptance criteria — met:

- a recycled/foreign pid is never signalled — ✅ (`autostart.test.ts` Phase E block).
- concurrent clients do not spawn duplicate servers when one is restarting — ✅
  (`autostart.test.ts` + `autostart.integration.test.ts` real-lock single-spawn case).

### Phase F: Crash diagnostics — ✅ Done

- On any fatal/uncaught path, `recordFatal` (`safety-net.ts:87-118`) emits exactly one
  structured `logServerEvent("error", "fatal_exit", {reason, uptimeMs, inFlight, queued,
  error})` (guarded by `firedFatal`) and best-effort writes a synchronous one-line crash
  record to `${discoveryPath}.crash` (`server.ts:250-252`).
- `pid`, `startedAt`, and `uptimeMs` are added to Health (`health.ts:26-34`) and Admin
  `GetMetrics` (`admin.ts:22-24`), with additive proto fields 3/4/5
  (`proto/ladybug_connection.proto`).

Acceptance criteria — met (caveat on test depth):

- every abnormal exit produces exactly one structured fatal record — ✅
  (`safety-net.test.ts`).
- diagnostics never block/delay the exit — ✅ (synchronous, error-swallowing writes).
- **Resolved 2026-06-16:** the Admin `GetMetrics` integration assertion now checks
  `pid`/`startedAt`/`uptimeMs`, and `safety-net.crash-record.test.ts` asserts the `.crash`
  file is actually written to disk on a fatal exit (and not on a clean exit).

## Follow-ups (resolved 2026-06-16)

Implemented in a second workflow-driven pass (4 parallel agents + a verify pass; `tsc` and
`dependency-cruiser` clean, all touched suites green — 132/132). Status:

1. ✅ **Phase A — real-fs crash test.** New `safety-net.crash-cleanup.test.ts` creates a real
   discovery file + real `proper-lockfile` lock in a temp dir, fires the safety net's
   `exit`/`uncaughtException` handlers (via the injectable fake `proc`/`exit`), and asserts on
   the real filesystem that both the discovery file and the lock directory are gone.
2. ✅ **Phase B — dead-code helpers.** Deleted `getConfiguredShutdownGraceMs/HardMs` from
   `limits.ts` and their `limits.test.ts` cases (the `DEFAULT_*` / `*_ENV` constants
   `ConfigurationManager` actually uses are retained). `tsc` confirms no dangling imports.
3. ✅ **Phase D — startup integration test.** New
   `connection-server.crash-recovery.integration.test.ts` boots a real `startConnectionServer`
   over a planted crashed-holder lock (back-dated `proper-lockfile` dir + dead-pid payload) and
   a stale discovery file (dead pid), and asserts the server self-heals — starts in < 5 s,
   overwrites the stale discovery with this process's pid, and reports `SERVING`. _(The lock is
   planted directly on disk rather than via a tiny `LADYBUG_DB_LOCK_STALE_MS` window:
   `proper-lockfile` clamps `stale` to a 2 s floor and an in-process held lock keeps refreshing
   its own mtime, so the env-window approach can't simulate a crash within one process.)_
4. ✅ **Phase D — config threading (done 2026-06-16, additive).** Lock tunables now thread through
   config like the shutdown timings: `lockStaleMs`/`lockRetries` on `LadybugServerConfig` +
   `serverLockStaleMs`/`serverLockRetries` on `FullConfig.ladybugdb`, read from
   `LADYBUG_DB_LOCK_STALE_MS`/`_RETRIES` in `ConfigurationManager`, mapped by `toLadybugServerConfig`,
   and passed `server.ts` → `runtime.open` → `createEmbeddedConnection` → `acquireFileLock`. Done
   **additively**: the threaded params are optional with the existing env-helper fallback
   (`getConfiguredDbLock*`), so config-less callers (`connection-pool.ts`, embedded use, tests) and
   the multi-repo path keep the process-global env default — only a per-repo server config overrides
   it. `acquireFileLock`'s options were factored into a reusable `LockTunables` type. The
   crash-recovery integration test was refactored to thread `lockStaleMs` via config instead of
   mutating `process.env`, proving the path end-to-end (passes 3×, no flakiness).
5. ✅ **Phase F — assertion depth.** The Admin `GetMetrics` integration assertion now also checks
   `pid === process.pid`, a parseable `startedAt`, and `uptimeMs >= 0`. New
   `safety-net.crash-record.test.ts` asserts the `.crash` record file is actually written to disk
   on a fatal exit (and that a clean exit writes nothing). _(The `CrashRecord` persists
   `at`/`reason`/`uptimeMs`/`inFlight`/`queued`; the `error` is logged, not written to disk.)_

**Drive-by fix (pre-existing, unrelated to this plan).** While editing
`connection-server.commands.integration.test.ts` for item 5, a stale assertion surfaced in the
same test: `DeleteRelationshipsByType("CALLS")` and `DeleteNodesByLabel("Symbol")` expected
`deletedCount: 0`, but the prefix-scoped deletes correctly return `1` and `3` against real Kùzu
(the test's own final `QueryNodes` expects an empty graph, confirming the delete-all intent).
This failure already exists at `HEAD` (`ad455bb`); the expected counts were corrected to match
actual behavior so the suite is green.

## Risk Notes

- `process.on("exit")` can only do **synchronous** work — the sync unlink helpers (Phase A)
  exist precisely for this constraint.
- `forceShutdown` cancels in-flight RPCs; clients must treat `UNAVAILABLE`/cancelled as
  retryable. ✅ `ServerShuttingDownError` maps to gRPC `UNAVAILABLE` with `retryable=true`
  (`src/infrastructure/remote-transport/errors.ts:75-84`).
- Lowering the lock `stale` window trades faster crash-recovery for a higher chance of two
  processes briefly believing they hold the DB — the implementation keeps the default and
  relies on pid-liveness (`file-lock.ts`) rather than only shrinking the timer.
- The hard-exit backstop timer is `unref`'d (`server.ts:118-130`) so it never *keeps* the
  process alive, and is the last resort after orderly cleanup.
- Changing shutdown ordering touched the integration tests
  (`connection-server.*.integration.test.ts`); they were updated alongside, with explicit
  hung-request and crash simulations added.
- **The message-size plan raised the gRPC ceiling to 64 MB**, allowing larger in-flight
  messages and raising peak memory per request, so `maxConcurrency` × 64 MB is a real OOM
  ceiling — an OOM is an unexpected stop landing on failure mode 1. This was extra
  motivation for Phases A/B (now done). Do not raise the limit further without accounting
  for `maxConcurrency`.

## Delivery Record (was: Suggested PR Sequence)

All landed together in commit `ad455bb` ("PERFORMANCE, RESILIENCE, BATCHING, METRICS,
LOCKING, CRASH-SAFETY, TESTS") on branch `feature/refactor-code-base`, implemented as two
workflow-driven passes (A+B+C, then D+E+F) with adversarial verification between them:

1. ✅ **Phase A** — process safety net + sync discovery/lock unlink.
2. ✅ **Phase B** — bounded drain + `forceShutdown` + `runtime.close` timeout + hard-exit
   backstop.
3. ✅ **Phase C** — reorder shutdown (advertise-off first) + `finally` cleanup.
4. ✅ **Phase D** — self-healing startup (stale lock/discovery reclaim, actionable errors).
5. ✅ **Phase E** — client autostart hardening (pid liveness/identity, restart backoff).
6. ✅ **Phase F** — crash diagnostics + Health/Admin uptime.

## Outcome

Phases A and B converted the two worst outcomes — "crash leaves orphaned lock/discovery"
and "shutdown hangs until SIGKILL" — into a bounded, self-cleaning exit, which also removed
the `Timeout terminating forks worker` class of hang observed during the test suite. Phases
C–F layered on incremental robustness. All nine failure modes are resolved; the only open
items are the test-coverage and dead-code follow-ups listed above.
