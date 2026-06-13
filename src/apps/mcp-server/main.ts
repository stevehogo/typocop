#!/usr/bin/env node
import { startMCPServer } from "./index.js";
import { loadEnv } from "../../platform/bootstrap.js";

async function main(): Promise<void> {
  // First -e/--env wins; quiet dotenv output (preserved MCP-server semantics).
  await loadEnv(process.argv.slice(2), { firstMatchWins: true, quiet: true });
  await startMCPServer();
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(msg + "\n");
  process.exit(1);
});
