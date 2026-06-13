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
  await server.waitForShutdown();
}

main().catch((error) => {
  logServerEvent("error", "fatal", { error });
  process.exit(1);
});
