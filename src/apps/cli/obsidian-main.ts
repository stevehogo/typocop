/**
 * Lightweight CLI entry point for the `obsidian` subcommand.
 * Does NOT import executor.ts or anything that touches tree-sitter.
 */
import { existsSync } from "node:fs";
import { readFile, appendFile } from "node:fs/promises";
import { parseArgs, CLIValidationError } from "./parser.js";
import { configurationManager, ConfigurationError, PrefixValidationError } from "../../platform/config/index.js";
import chalk from "chalk";
import ora from "ora";
import { executeObsidianExport } from "../../application/export-render/index.js";
import { createDatabaseAdapter } from "../../infrastructure/persistence/database-adapter.js";
import { createEmbeddingAdapterFromConfig } from "../../infrastructure/embeddings/embedding-factory.js";
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

/**
 * Append the output directory to .gitignore if it isn't already listed.
 */
async function ensureGitignore(outputPath: string): Promise<void> {
  const gitignorePath = ".gitignore";
  // Normalize: strip leading ./ for consistent matching
  const entry = outputPath.replace(/^\.\//, "");

  try {
    if (existsSync(gitignorePath)) {
      const content = await readFile(gitignorePath, "utf-8");
      const lines = content.split("\n");
      if (lines.some((line) => line.trim() === entry || line.trim() === `/${entry}`)) {
        return;
      }
      const trailing = content.endsWith("\n") ? "" : "\n";
      await appendFile(gitignorePath, `${trailing}${entry}\n`, "utf-8");
    } else {
      await appendFile(gitignorePath, `${entry}\n`, "utf-8");
    }
    console.error(chalk.dim(`[obsidian] Added "${entry}" to .gitignore`));
  } catch {
    // Non-fatal — don't fail the export over a .gitignore issue
  }
}

export async function runObsidianCLI(argv: string[]): Promise<void> {
  let envPath: string | undefined;
  let envExplicit = false;
  const filteredArgv: string[] = [];
  let isShuttingDown = false;

  // Set up signal handlers for graceful shutdown on Ctrl+C
  const handleSignal = async (signal: string) => {
    if (isShuttingDown) {
      return; // Already shutting down
    }
    isShuttingDown = true;
    console.error(`\n[typocop] Received ${signal}, shutting down gracefully...`);
    await drainAllPools();
    process.exit(130); // Standard exit code for SIGINT
  };

  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

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
  } catch (err: unknown) {
    if (err instanceof CLIValidationError) {
      process.stderr.write(err.message + "\n");
      await drainAllPools();
      process.exit(1);
    }
    const anyErr = err as { code?: string; exitCode?: number };
    if (anyErr?.code === "commander.helpDisplayed" || anyErr?.code === "commander.version") {
      await drainAllPools();
      process.exit(anyErr.exitCode ?? 0);
    }
    throw err;
  }

  if (command.type !== "obsidian") {
    process.stderr.write("Unexpected command routed to obsidian handler\n");
    await drainAllPools();
    process.exit(1);
    return;
  }

  const { outputPath, verbose } = command.config;
  console.error(chalk.blue(`Exporting knowledge graph to Obsidian vault at ${outputPath}`));
  const spinner = ora("Exporting graph to Obsidian vault...").start();

  try {
    if (verbose) {
      spinner.info("Verbose mode enabled.");
    }
    const adapterConfig = configurationManager.getConfiguration();
    const adapter = await createDatabaseAdapter(adapterConfig, createEmbeddingAdapterFromConfig(adapterConfig));
    try {
      const result = await executeObsidianExport(command.config, adapter);
      await ensureGitignore(outputPath);
      spinner.succeed(chalk.green("Obsidian vault export completed."));
      console.error(chalk.bold("\nExport Statistics:"));
      console.error(`  Files written:       ${chalk.cyan(result.filesWritten)}`);
      console.error(`  Directories created: ${chalk.cyan(result.directoriesCreated)}`);
      console.error(`  Total bytes:         ${chalk.cyan(result.totalBytes)}`);
    } finally {
      await adapter.close();
    }
    await drainAllPools();
    process.exit(0);
  } catch (err) {
    if (isShuttingDown) {
      // Already handling shutdown, don't print error
      await drainAllPools();
      process.exit(1);
    }
    spinner.fail(chalk.red("Obsidian export failed."));
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(msg + "\n");
    await drainAllPools();
    process.exit(1);
  }
}
