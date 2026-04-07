#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseArgs, executeCLI, CLIValidationError } from "./index.js";
import { configurationManager, ConfigurationError, PrefixValidationError } from "../config/index.js";

function formatConfigurationError(err: ConfigurationError): string {
  if (err instanceof PrefixValidationError) {
    const lines = [
      `Error: Invalid TYPOCOP_PREFIX value "${err.prefix}"`,
      `Reason: ${err.reason}`,
    ];
    if (err.suggestion) {
      lines.push(`Suggestion: ${err.suggestion}`);
    }
    return lines.join("\n") + "\n";
  }
  return `Error: ${err.message}\n`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let envPath: string | undefined;
  let envExplicit = false;
  const filteredArgv: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === "-e" || argv[i] === "--env") && i + 1 < argv.length) {
      envPath = argv[++i];
      envExplicit = true;
    } else {
      filteredArgv.push(argv[i]);
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

  try {
    await configurationManager.initialize();
  } catch (err) {
    if (err instanceof ConfigurationError) {
      process.stderr.write(formatConfigurationError(err));
      process.exit(1);
    }
    throw err;
  }

  // Req 17.1: Log effective prefix at startup (ConfigurationManager already logs it,
  // but surface it here so CLI users see it in the same output stream as other CLI logs)
  console.log(`[typocop] Effective prefix: ${configurationManager.getPrefix()}`);

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
