#!/usr/bin/env node

import { ConfigurationManager } from "../../platform/config/configuration-manager.js";
import { applyArgEnvOverrides } from "../../platform/bootstrap.js";
import { logServerEvent } from "../../platform/logging/logger.js";
import { toLadybugServerConfig, startConnectionServer } from "./server.js";

const ARG_TO_ENV: Record<string, string> = {
  "--db-path": "LADYBUGDB_PATH",
  "--prefix": "TYPOCOP_PREFIX",
  "--host": "LADYBUG_SERVER_HOST",
  "--port": "LADYBUG_SERVER_PORT",
  "--auth-token": "LADYBUG_SERVER_AUTH_TOKEN",
  "--grpc-max-message-bytes": "LADYBUG_GRPC_MAX_MESSAGE_BYTES",
  "--max-concurrency": "LADYBUG_SERVER_MAX_CONCURRENCY",
  "--max-queue": "LADYBUG_SERVER_MAX_QUEUE",
  "--idle-ttl-ms": "LADYBUG_SERVER_IDLE_TTL_MS",
  "--discovery-path": "LADYBUG_SERVER_DISCOVERY_PATH",
};

async function main(): Promise<void> {
  applyArgEnvOverrides(process.argv.slice(2), ARG_TO_ENV);
  process.env["LADYBUG_RUNTIME_MODE"] = "server";

  const manager = new ConfigurationManager();
  await manager.initialize();
  const config = manager.getConfiguration();
  const serverConfig = toLadybugServerConfig(config);

  if (serverConfig.runtimeMode !== "server") {
    throw new Error(`Expected LADYBUG_RUNTIME_MODE=server but received ${serverConfig.runtimeMode}`);
  }

  const server = await startConnectionServer(serverConfig);
  try {
    await server.waitForShutdown();
  } catch (error) {
    // waitForShutdown rejected (shutdown failed): run best-effort cleanup so no
    // orphaned discovery/lock is left behind before exiting non-zero.
    await server.shutdown("fatal").catch(() => undefined);
    throw error;
  }
}

main().catch((error) => {
  // Phase F: structured fatal record on the main() rejection path (a startup or
  // waitForShutdown failure that does NOT surface as an uncaughtException, so it
  // would otherwise escape the safety net's fatal_exit emission). Diagnostics
  // (uptime/inFlight/queued) are unavailable here — the server either never
  // fully started or its scheduler is gone — so only `reason`/`error` are known.
  logServerEvent("error", "fatal_exit", { reason: "main", error });
  // Best-effort cleanup runs via the installed process safety net (exit handler
  // performs the synchronous discovery/lock unlink). Exit non-zero.
  process.exit(1);
});
