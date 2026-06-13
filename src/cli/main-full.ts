/**
 * Full CLI entry point for parse, reindex, status commands.
 * Statically imports executor.ts which loads tree-sitter via the indexer.
 */
import { existsSync } from "node:fs";
import { parseArgs, executeCLI, CLIValidationError } from "./index.js";
import { configurationManager, ConfigurationError, PrefixValidationError } from "../platform/config/index.js";
import { drainAllPools } from "../infrastructure/persistence/pool-registry.js";

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

export async function runFullCLI(argv: string[]): Promise<void> {
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
        await drainAllPools();
        process.exit(1);
      }
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
      await drainAllPools();
      process.exit(1);
    }
    throw err;
  }

  console.error(`[typocop] Effective prefix: ${configurationManager.getPrefix()}`);

  let command;
  try {
    command = parseArgs(["node", "typocop", ...filteredArgv]);
  } catch (err: any) {
    if (err instanceof CLIValidationError) {
      process.stderr.write(err.message + "\n");
      await drainAllPools();
      process.exit(1);
    }
    if (err?.code === "commander.helpDisplayed" || err?.code === "commander.version") {
      await drainAllPools();
      process.exit(err.exitCode ?? 0);
    }
    throw err;
  }

  // Handle graceful shutdown on SIGINT
  let isShuttingDown = false;
  const handleShutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    process.stderr.write("\n");
    await drainAllPools();
    process.exit(130); // Standard exit code for SIGINT
  };

  process.on("SIGINT", handleShutdown);

  try {
    await executeCLI(command);
    await drainAllPools();
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(msg + "\n");
    await drainAllPools();
    process.exit(1);
  }
}
