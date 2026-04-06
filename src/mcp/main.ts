#!/usr/bin/env node
import { existsSync } from "node:fs";
import { startMCPServer } from "./index.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let envPath: string | undefined;
  let envExplicit = false;

  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === "-e" || argv[i] === "--env") && i + 1 < argv.length) {
      envPath = argv[++i];
      envExplicit = true;
      break;
    }
  }

  if (!envExplicit) {
    envPath = ".env-typocop";
  }

  if (envPath !== undefined) {
    if (!existsSync(envPath)) {
      if (envExplicit) {
        process.stderr.write(`Error: env file not found: ${envPath}\n`);
        process.exit(1);
      }
      // default file missing is fine — skip silently
    } else {
      const { config } = await import("dotenv");
      config({ path: envPath });
    }
  }

  await startMCPServer();
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(msg + "\n");
  process.exit(1);
});
