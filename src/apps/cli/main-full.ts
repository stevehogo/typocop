/**
 * Full CLI entry point for parse, reindex, status commands.
 * Statically imports executor.ts which loads tree-sitter via the indexer.
 */
import { parseArgs, executeCLI, CLIValidationError } from "./index.js";
import { configurationManager, ConfigurationError, PrefixValidationError } from "../../platform/config/index.js";
import { loadEnv } from "../../platform/bootstrap.js";
import { drainAllPools } from "../../infrastructure/persistence/pool-registry.js";

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
  // Last -e/--env wins, strip it from argv for parseArgs, drain pools on a
  // missing explicit env file before exiting (preserved CLI semantics).
  const { argv: filteredArgv } = await loadEnv(argv, {
    stripEnvFlag: true,
    onMissingExplicitEnv: drainAllPools,
  });

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
    // Honour an exit code a command set on success (e.g. `check-recursion`
    // exits 1 when it finds issues, for CI gating). Unset ⇒ 0, as before.
    process.exit(process.exitCode ?? 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(msg + "\n");
    await drainAllPools();
    process.exit(1);
  }
}
