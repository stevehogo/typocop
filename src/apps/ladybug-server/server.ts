import * as grpc from "@grpc/grpc-js";

import type { FullConfig, LadybugServerConfig } from "../../platform/config/types.js";
import { removeDiscoveryFile, writeDiscoveryFile } from "../../infrastructure/remote-transport/discovery.js";
import { loadConnectionProtoPackage } from "../../infrastructure/remote-transport/proto-loader.js";
import { logServerEvent } from "../../platform/logging/logger.js";
import { toServiceError } from "../../infrastructure/remote-transport/errors.js";
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

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export async function startConnectionServer(config: LadybugServerConfig): Promise<ConnectionServerHandle> {
  const runtime = new LadybugEmbeddedDatabaseRuntime();
  await runtime.open(config.dbPath, config.prefix);
  try {
    const scheduler = new PriorityRequestScheduler(config.maxConcurrency, config.maxQueue);
    const metrics = new InMemoryMetricsCollector({
      isDatabaseOpen: () => runtime.isHealthy(),
      getSchedulerStats: () => scheduler.stats(),
    });
    const router = new DefaultOperationRouter(runtime, scheduler, config.prefix, metrics);

    const services = loadConnectionProtoPackage();

    const grpcServer = new grpc.Server({
      "grpc.max_receive_message_length": MAX_MESSAGE_BYTES,
      "grpc.max_send_message_length": MAX_MESSAGE_BYTES,
    });

    const shutdownWaiter = deferred<void>();
    let shuttingDown = false;
    let shutdownPromise: Promise<void> | null = null;
    let idleTimer: NodeJS.Timeout | null = null;

    async function shutdown(reason: string): Promise<void> {
      if (shuttingDown) {
        return shutdownPromise ?? shutdownWaiter.promise;
      }
      shuttingDown = true;
      if (idleTimer) {
        clearInterval(idleTimer);
        idleTimer = null;
      }
      logServerEvent("info", "shutdown_started", { reason });

      shutdownPromise = (async () => {
        try {
          const drainPromise = scheduler.drain();
          await new Promise<void>((resolve) => {
            grpcServer.tryShutdown(() => resolve());
          });
          await drainPromise;
          await runtime.close();
          await removeDiscoveryFile(config.discoveryPath);
          shutdownWaiter.resolve();
        } catch (error) {
          logServerEvent("error", "shutdown_failed", { reason, error });
          shutdownWaiter.reject(error);
          throw error;
        }
      })();

      return shutdownPromise;
    }

    grpcServer.addService(
      services.Health.service,
      withAuth(config.authToken, createHealthService(runtime, scheduler)),
    );
    grpcServer.addService(
      services.Admin.service,
      withAuth(config.authToken, createAdminService({
        metrics,
        getSchedulerStats: () => scheduler.stats(),
        shutdown,
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
      maxConcurrency: config.maxConcurrency,
      maxQueue: config.maxQueue,
    });

    return {
      shutdown,
      waitForShutdown: () => shutdownWaiter.promise,
    };
  } catch (error) {
    await runtime.close().catch(() => undefined);
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
    maxConcurrency: config.ladybugdb.serverMaxConcurrency,
    maxQueue: config.ladybugdb.serverMaxQueue,
    idleTtlMs: config.ladybugdb.serverIdleTtlMs,
    discoveryPath: config.ladybugdb.serverDiscoveryPath,
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
