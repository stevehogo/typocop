import { CLICommand } from "./parser.js";
import chalk from "chalk";
import ora from "ora";

export interface IndexingStats {
  symbolCount: number;
  relationshipCount: number;
  clusterCount: number;
  processCount: number;
  skippedFiles: number;
}

export interface GraphStatus {
  symbolCount: number;
  relationshipCount: number;
  lastIndexed: string | null;
}

// Placeholder — replaced when pipeline is wired in (tasks 3–14)
async function runIndexingPipeline(
  sourcePath: string,
  language: string,
  verbose: boolean
): Promise<IndexingStats> {
  void sourcePath;
  void language;
  void verbose;
  return { symbolCount: 0, relationshipCount: 0, clusterCount: 0, processCount: 0, skippedFiles: 0 };
}

// Placeholder — replaced when graph DB is wired in (task 12)
async function readGraphStatus(_dbPath?: string): Promise<GraphStatus> {
  return { symbolCount: 0, relationshipCount: 0, lastIndexed: null };
}

export async function executeCLI(command: CLICommand): Promise<void> {
  switch (command.type) {
    case "parse": {
      const { sourcePath, language, verbose } = command.config;
      console.log(chalk.blue(`Initializing indexing for ${language} codebase at ${sourcePath}`));

      const spinner = ora("Starting multi-phase indexing pipeline...").start();

      try {
        if (verbose) {
          spinner.info("Verbose mode enabled.");
        }

        const stats = await runIndexingPipeline(sourcePath, language, verbose);

        spinner.succeed(chalk.green("Indexing completed successfully."));
        console.log(chalk.bold("\nStatistics:"));
        console.log(`  Symbols:       ${chalk.cyan(stats.symbolCount)}`);
        console.log(`  Relationships: ${chalk.cyan(stats.relationshipCount)}`);
        console.log(`  Clusters:      ${chalk.cyan(stats.clusterCount)}`);
        console.log(`  Processes:     ${chalk.cyan(stats.processCount)}`);

        if (stats.skippedFiles > 0) {
          console.log(chalk.yellow(`  Skipped files: ${stats.skippedFiles} (syntax errors or unreadable)`));
        }
      } catch (err) {
        spinner.fail(chalk.red("Indexing failed."));
        throw err;
      }
      break;
    }

    case "reindex": {
      const spinner = ora(`Reindexing database at ${command.dbPath}...`).start();
      try {
        await runIndexingPipeline(command.dbPath, "typescript", false);
        spinner.succeed(chalk.green("Reindexing complete."));
      } catch (err) {
        spinner.fail(chalk.red("Reindexing failed."));
        throw err;
      }
      break;
    }

    case "status": {
      const status = await readGraphStatus();
      console.log(chalk.bold("Knowledge Graph Status:"));
      console.log(`  Last Indexed:  ${chalk.cyan(status.lastIndexed ?? "never")}`);
      console.log(`  Symbols:       ${chalk.cyan(status.symbolCount)}`);
      console.log(`  Relationships: ${chalk.cyan(status.relationshipCount)}`);
      break;
    }
  }
}
