import { appendFileSync } from "node:fs";

import * as grpc from "@grpc/grpc-js";

import type { FullConfig, LadybugServerConfig } from "../../platform/config/types.js";
import {
  readDiscoveryFile,
  removeDiscoveryFile,
  removeDiscoveryFileSync,
  writeDiscoveryFile,
} from "../../infrastructure/remote-transport/discovery.js";
import type { DiscoveryFile } from "../../infrastructure/remote-transport/types.js";
import { releaseFileLockSync } from "../../infrastructure/persistence/file-lock.js";
import { loadConnectionProtoPackage } from "../../infrastructure/remote-transport/proto-loader.js";
import { logServerEvent } from "../../platform/logging/logger.js";
import { withTimeoutOr } from "../../platform/utils/limits.js";
import { toServiceError } from "../../infrastructure/remote-transport/errors.js";
import type { CrashRecord } from "./safety-net.js";
import { installProcessSafetyNet } from "./safety-net.js";
import { InMemoryMetricsCollector } from "./metrics.js";
import { DefaultOperationRouter } from "./router.js";
import { LadybugEmbeddedDatabaseRuntime } from "./runtime.js";
import { PriorityRequestScheduler } from "./scheduler.js";
import { createAdminService } from "./services/admin.js";
import { createGraphService } from "./services/graph.js";
import { createHealthService } from "./services/health.js";
import { createVectorService } from "./services/vector.js";

export interface ConnectionServerHandle {
  readonly shutdown: (reason: string) => Promise<void>;
  readonly waitForShutdown: () => Promise<void>;
}

export async function startConnectionServer(config: LadybugServerConfig): Promise<ConnectionServerHandle> {
  // Phase F: captured once so uptime in diagnostics and Health/Admin responses
  // is consistent across the server's lifetime.
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();

  const runtime = new LadybugEmbeddedDatabaseRuntime();
  await runtime.open(config.dbPath, config.prefix, {
    staleMs: config.lockStaleMs,
    retries: config.lockRetries,
  });

  // Hoisted so the startup-failure catch (outer scope) can dispose the safety
  // net and run last-ditch cleanup even when start() throws mid-wiring.
  let disposeSafetyNet: (() => void) | null = null;
  let startupCleanupSync: (() => void) | null = null;
  try {
    const scheduler = new PriorityRequestScheduler(config.maxConcurrency, config.maxQueue);
    const metrics = new InMemoryMetricsCollector({
      isDatabaseOpen: () => runtime.isHealthy(),
      getSchedulerStats: () => scheduler.stats(),
    });
    const router = new DefaultOperationRouter(runtime, scheduler, config.prefix, metrics);

    const services = loadConnectionProtoPackage();

    const grpcServer = new grpc.Server({
      "grpc.max_receive_message_length": config.grpcMaxMessageBytes,
      "grpc.max_send_message_length": config.grpcMaxMessageBytes,
    });

    const shutdownWaiter = deferred<void>();
    let shuttingDown = false;
    let shutdownPromise: Promise<void> | null = null;
    let idleTimer: NodeJS.Timeout | null = null;

    // proper-lockfile's lock lives at `${dbPath}.lock` (acquireFileLock), so the
    // sync exit unlink targets that path. The server does not directly hold the
    // FileLock object (it lives in connection.ts activeLocks); this is the
    // best-effort last-ditch drop for unexpected exits.
    const lockPath = `${config.dbPath}.lock`;

    // Shared between the async graceful path and the sync exit path so cleanup
    // (discovery + lock removal + logging) never double-runs or double-unlinks.
    let cleanedUp = false;

    function cleanupSync(): void {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      removeDiscoveryFileSync(config.discoveryPath);
      releaseFileLockSync(lockPath);
    }
    startupCleanupSync = cleanupSync;

    async function cleanupAsync(): Promise<void> {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      // Discovery removal must not be able to abort lock/runtime cleanup.
      await removeDiscoveryFile(config.discoveryPath).catch((error: unknown) => {
        logServerEvent("error", "discovery_remove_failed", { error });
      });
      releaseFileLockSync(lockPath);
    }

    async function shutdown(reason: string): Promise<void> {
      if (shuttingDown) {
        return shutdownPromise ?? shutdownWaiter.promise;
      }
      shuttingDown = true;
      if (idleTimer) {
        clearInterval(idleTimer);
        idleTimer = null;
      }
      // Phase C: stop accepting work IMMEDIATELY so Health flips to NOT_SERVING.
      scheduler.markDraining();
      logServerEvent("info", "shutdown_started", { reason });

      // Phase B: absolute backstop — if the orderly sequence wedges, force-exit.
      // unref'd so it never keeps the process alive on its own. Its deadline is
      // the SUM of the bounded steps (grace for gRPC + hard for runtime.close)
      // plus a small margin, so it only fires when the orderly bounded sequence
      // itself failed to complete — never racing the steps' own deadlines.
      let completed = false;
      const hardExitDeadlineMs = config.shutdownGraceMs + config.shutdownHardMs + 1_000;
      const hardExitTimer = setTimeout(() => {
        if (completed) {
          return;
        }
        logServerEvent("error", "shutdown_hard_exit", {
          reason,
          hardExitDeadlineMs,
        });
        cleanupSync();
        process.exit(1);
      }, hardExitDeadlineMs);
      hardExitTimer.unref?.();

      shutdownPromise = (async () => {
        try {
          // Phase C(1): stop advertising FIRST; failure must not abort the rest.
          await removeDiscoveryFile(config.discoveryPath).catch((error: unknown) => {
            logServerEvent("error", "discovery_remove_failed", { reason, error });
          });

          // Phase C(2) / Phase B: race graceful gRPC shutdown against the grace
          // deadline; on timeout force-cancel in-flight connections.
          const drainPromise = scheduler.drain(config.shutdownGraceMs);
          await raceGrpcShutdown(grpcServer, config.shutdownGraceMs);

          // Phase C(3): bounded drain (resolves by deadline even if work hangs).
          await drainPromise;

          // Phase C(4): bounded native DB close. A close failure or timeout is
          // logged and SWALLOWED — discovery/lock are already (about to be)
          // cleaned up in the finally, and the server must still finish its own
          // shutdown rather than treat it as a fatal error. The inner fn never
          // rejects (errors are captured as a discriminant) so withTimeoutOr has
          // nothing to leave unhandled.
          const TIMED_OUT = "timed-out" as const;
          const CLOSED = "closed" as const;
          type CloseOutcome =
            | typeof TIMED_OUT
            | typeof CLOSED
            | { readonly error: unknown };
          const closed = await withTimeoutOr<CloseOutcome>(
            async () => {
              try {
                await runtime.close();
                return CLOSED;
              } catch (closeError) {
                return { error: closeError };
              }
            },
            config.shutdownHardMs,
            () => TIMED_OUT,
          );
          if (closed === TIMED_OUT) {
            logServerEvent("error", "runtime_close_timeout", { reason, shutdownHardMs: config.shutdownHardMs });
          } else if (typeof closed === "object") {
            logServerEvent("error", "runtime_close_failed", { reason, error: closed.error });
          }

          shutdownWaiter.resolve();
        } catch (error) {
          logServerEvent("error", "shutdown_failed", { reason, error });
          shutdownWaiter.reject(error);
          throw error;
        } finally {
          // Phase C(5): discovery + lock cleanup run whether or not the DB
          // close succeeded/threw/timed out.
          await cleanupAsync();
          completed = true;
          clearTimeout(hardExitTimer);
          if (disposeSafetyNet) {
            disposeSafetyNet();
            disposeSafetyNet = null;
          }
        }
      })();

      return shutdownPromise;
    }

    // Phase F: identity + liveness so a supervisor can detect flapping.
    const serverInfo = {
      pid: process.pid,
      startedAt: startedAtIso,
      uptimeMs: () => Date.now() - startedAtMs,
    };
    grpcServer.addService(
      services.Health.service,
      withAuth(config.authToken, createHealthService(runtime, scheduler, serverInfo)),
    );
    grpcServer.addService(
      services.Admin.service,
      withAuth(config.authToken, createAdminService({
        metrics,
        getSchedulerStats: () => scheduler.stats(),
        shutdown,
        serverInfo,
      })),
    );
    grpcServer.addService(
      services.Graph.service,
      withAuth(config.authToken, createGraphService(router)),
    );
    grpcServer.addService(
      services.Vector.service,
      withAuth(config.authToken, createVectorService(router)),
    );

    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });

    // Phase A: safety net for unexpected exits (uncaughtException /
    // unhandledRejection / process exit). The disposer is invoked at the end of
    // graceful shutdown so these listeners don't leak across server instances.
    disposeSafetyNet = installProcessSafetyNet({
      cleanupSync,
      cleanupAsync: () => shutdown("fatal"),
      // Phase F: fold a liveness snapshot into the single fatal_exit record.
      getDiagnostics: () => {
        const stats = scheduler.stats();
        return {
          uptimeMs: Date.now() - startedAtMs,
          inFlight: stats.inFlight,
          queued: stats.queued,
        };
      },
      // Phase F: best-effort SYNC one-line crash record next to the discovery
      // file for post-mortem. Must never throw (swallowed by the safety net).
      writeCrashRecordSync: (record: CrashRecord) => {
        appendFileSync(`${config.discoveryPath}.crash`, `${JSON.stringify(record)}\n`);
      },
    });

    await new Promise<void>((resolve, reject) => {
      grpcServer.bindAsync(
        `${config.host}:${config.port}`,
        grpc.ServerCredentials.createInsecure(),
        (error: Error | null) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        },
      );
    });

    grpcServer.start();

    // Phase D: self-healing startup. The server always overwrites its discovery
    // file, but make the reclaim of a stale advertisement EXPLICIT: if an
    // existing file points at a dead pid, log that it is being reclaimed. This
    // is best-effort and must never block startup, so failures are swallowed.
    await reclaimStaleDiscovery(config.discoveryPath, readDiscoveryFile, isPidAlive);

    await writeDiscoveryFile(config.discoveryPath, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      prefix: config.prefix,
      dbPath: config.dbPath,
      url: `grpc://${config.host}:${config.port}`,
    });

    if (config.idleTtlMs > 0) {
      let lastBusyAt = Date.now();
      idleTimer = setInterval(() => {
        const stats = scheduler.stats();
        if (stats.inFlight > 0 || stats.queued > 0) {
          lastBusyAt = Date.now();
          return;
        }
        if (Date.now() - lastBusyAt >= config.idleTtlMs) {
          void shutdown("idle-timeout");
        }
      }, Math.min(config.idleTtlMs, 1000));
    }

    logServerEvent("info", "server_started", {
      url: `grpc://${config.host}:${config.port}`,
      prefix: config.prefix,
      dbPath: config.dbPath,
      grpcMaxMessageBytes: config.grpcMaxMessageBytes,
      maxConcurrency: config.maxConcurrency,
      maxQueue: config.maxQueue,
    });

    return {
      shutdown,
      waitForShutdown: () => shutdownWaiter.promise,
    };
  } catch (error) {
    // Startup failed after open(): drop any advertisement/lock and remove the
    // safety-net listeners so a fatal start leaves no orphaned state.
    if (disposeSafetyNet) {
      disposeSafetyNet();
      disposeSafetyNet = null;
    }
    await runtime.close().catch(() => undefined);
    startupCleanupSync?.();
    throw error;
  }
}

export function toLadybugServerConfig(config: FullConfig): LadybugServerConfig {
  return {
    runtimeMode: config.ladybugdb.runtimeMode,
    prefix: config.prefix,
    dbPath: config.ladybugdb.dbPath,
    host: config.ladybugdb.serverHost,
    port: config.ladybugdb.serverPort,
    authToken: config.ladybugdb.serverAuthToken,
    grpcMaxMessageBytes: config.ladybugdb.grpcMaxMessageBytes,
    maxConcurrency: config.ladybugdb.serverMaxConcurrency,
    maxQueue: config.ladybugdb.serverMaxQueue,
    idleTtlMs: config.ladybugdb.serverIdleTtlMs,
    discoveryPath: config.ladybugdb.serverDiscoveryPath,
    shutdownGraceMs: config.ladybugdb.serverShutdownGraceMs,
    shutdownHardMs: config.ladybugdb.serverShutdownHardMs,
    lockStaleMs: config.ladybugdb.serverLockStaleMs,
    lockRetries: config.ladybugdb.serverLockRetries,
  };
}

function withAuth(
  authToken: string,
  implementation: Record<string, (...args: any[]) => any>,
): Record<string, (...args: any[]) => any> {
  if (authToken === "") {
    return implementation;
  }

  return Object.fromEntries(
    Object.entries(implementation).map(([name, handler]) => [
      name,
      async (call: { readonly metadata?: { get: (key: string) => string[] } }, callback: (error: unknown, response?: unknown) => void) => {
        try {
          const authorization = call.metadata?.get("authorization")?.[0] || "";
          if (authorization !== `Bearer ${authToken}`) {
            const error = new Error("Missing or invalid bearer token") as Error & { readonly code: number };
            Object.assign(error, { code: grpc.status.UNAUTHENTICATED });
            throw error;
          }
          return await handler(call, callback);
        } catch (error) {
          callback(toServiceError(error));
        }
      },
    ]),
  );
}

/**
 * Race the graceful `tryShutdown()` against the grace deadline. If in-flight
 * RPCs do not finish in time, escalate to `forceShutdown()` so the transport
 * layer can never hang the process (resilience Phase B). Clients already treat
 * cancelled/UNAVAILABLE as retryable.
 */
function raceGrpcShutdown(grpcServer: grpc.Server, graceMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(graceTimer);
      resolve();
    };

    const graceTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      logServerEvent("warn", "grpc_force_shutdown", { graceMs });
      grpcServer.forceShutdown();
      finish();
    }, graceMs);
    graceTimer.unref?.();

    grpcServer.tryShutdown(() => finish());
  });
}

/** Best-effort liveness probe: signal 0 tests existence without killing. */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means the process exists but we lack permission to signal it.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Self-healing startup helper (resilience Phase D): inspect an existing
 * discovery file and, if it advertises a server whose pid is no longer alive
 * (i.e. left behind by a previous crash), log that it is being reclaimed before
 * the caller overwrites it. Best-effort and non-blocking — any failure is
 * swallowed and never aborts startup. The `readDiscovery` and `pidAlive` deps
 * are injectable for tests.
 */
export async function reclaimStaleDiscovery(
  discoveryPath: string,
  readDiscovery: (path: string) => Promise<DiscoveryFile | null>,
  pidAlive: (pid: number) => boolean,
): Promise<void> {
  try {
    const existing = await readDiscovery(discoveryPath);
    if (existing === null) {
      return;
    }
    const pid = existing.pid;
    if (typeof pid === "number" && pid > 0 && pidAlive(pid)) {
      // A live process is still advertised here. The previous server may not
      // have shut down cleanly yet; record it but still let startup proceed and
      // overwrite (the new server now owns the lock, so the old one is gone).
      logServerEvent("warn", "discovery_overwrite_live_pid", {
        discoveryPath,
        pid,
        url: existing.url,
      });
      return;
    }
    logServerEvent("info", "discovery_reclaimed_stale", {
      discoveryPath,
      pid,
      url: existing.url,
      startedAt: existing.startedAt,
    });
  } catch (error: unknown) {
    // Never block startup on the reclaim check.
    logServerEvent("warn", "discovery_reclaim_check_failed", { discoveryPath, error });
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolveFn!: (value: T | PromiseLike<T>) => void;
  let rejectFn!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}
