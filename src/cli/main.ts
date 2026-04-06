#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseArgs, executeCLI, CLIValidationError } from "./index.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let envPath: string | undefined;
  const filteredArgv: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === "-e" || argv[i] === "--env") && i + 1 < argv.length) {
      envPath = argv[++i];
    } else {
      filteredArgv.push(argv[i]);
    }
  }

  if (envPath !== undefined) {
    if (!existsSync(envPath)) {
      process.stderr.write(`Error: env file not found: ${envPath}\n`);
      process.exit(1);
    }
    const { config } = await import("dotenv");
    config({ path: envPath });
  }

  let command;
  try {
    command = parseArgs(["node", "typocop", ...filteredArgv]);
  } catch (err: any) {
    if (err instanceof CLIValidationError) {
      process.stderr.write(err.message + "\n");
      process.exit(1);
    }
    if (err?.code === "commander.helpDisplayed" || err?.code === "commander.version") {
      process.exit(err.exitCode ?? 0);
    }
    throw err;
  }

  try {
    await executeCLI(command);
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(msg + "\n");
    process.exit(1);
  }
}

main();
