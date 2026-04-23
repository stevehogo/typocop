/**
 * CLI executor — creates DatabaseAdapter and runs commands.
 * Requirements: 1.1, 3.1–3.8, 5.1, 7.1, 7.2, 7.4
 */
import { CLICommand } from "./parser.js";
import chalk from "chalk";
import ora from "ora";
import { createDatabaseAdapter } from "../db/database-adapter.js";
import { runIndexingPipeline, type PipelineConfig } from "../indexer/pipeline.js";
import { configurationManager } from "../config/index.js";
import type { DatabaseAdapter } from "../db/types.js";
import { executeObsidianExport } from "../obsidian-export/index.js";

export interface ClearingStats {
  nodesDeleted: number;
  relationshipsDeleted: number;
  embeddingsDeleted: number;
}

export interface IndexingStats {
  symbolCount: number;
  relationshipCount: number;
  clusterCount: number;
  processCount: number;
  skippedFiles: number;
  embeddingCount: number;
  clearingStats?: ClearingStats;
}

export interface GraphStatus {
  symbolCount: number;
  relationshipCount: number;
  lastIndexed: string | null;
}

/**
 * Execute the indexing pipeline with DatabaseAdapter.
 * Requirements: 1.1, 3.1–3.8, 5.1, 7.1, 7.2, 7.4
 */
export async function executeIndexingPipeline(
  sourcePath: string,
  language: string,
  verbose: boolean,
  refresh?: boolean,
): Promise<IndexingStats> {
  const prefix = configurationManager.getPrefix();
  console.error(chalk.dim(`[typocop] Effective prefix: ${prefix}`));

  const config = configurationManager.getConfiguration();
  const adapter: DatabaseAdapter = await createDatabaseAdapter(config);

  try {
    let clearingStats: ClearingStats | undefined;

    // Clear existing data if refresh is requested (before Phase 1)
    if (refresh) {
      if (verbose) {
        console.error(chalk.yellow("[typocop] Refresh flag enabled: clearing existing graph and vector data..."));
      }

      const graphAdapter = adapter.getGraphAdapter();
      const vectorAdapter = adapter.getVectorAdapter();

      // Clear graph data by deleting node labels (adapter handles prefix)
      const symbolsDeleted = await graphAdapter.deleteNodesByLabel("Symbol");
      const clustersDeleted = await graphAdapter.deleteNodesByLabel("Cluster");
      const processesDeleted = await graphAdapter.deleteNodesByLabel("Process");
      await graphAdapter.deleteNodesByLabel("Metadata");

      const callsDeleted = await graphAdapter.deleteRelationshipsByType("CALLS");
      const importsDeleted = await graphAdapter.deleteRelationshipsByType("IMPORTS");
      const containsDeleted = await graphAdapter.deleteRelationshipsByType("CONTAINS");
      const hasStepDeleted = await graphAdapter.deleteRelationshipsByType("HAS_STEP");

      // Clear vector data
      const embeddingsDeleted = await vectorAdapter.deleteAll();

      clearingStats = {
        nodesDeleted: symbolsDeleted + clustersDeleted + processesDeleted,
        relationshipsDeleted: callsDeleted + importsDeleted + containsDeleted + hasStepDeleted,
        embeddingsDeleted,
      };

      if (verbose) {
        console.error(chalk.green("[typocop] Clearing completed successfully."));
      }
    }

    const pipelineConfig: PipelineConfig = {
      sourcePath,
      language: language as PipelineConfig["language"],
      verbose,
      adapter,
    };

    const result = await runIndexingPipeline(pipelineConfig);

    return {
      symbolCount: result.symbols.length,
      relationshipCount: result.relationships.length,
      clusterCount: result.clusters.length,
      processCount: result.processes.length,
      skippedFiles: result.skippedFiles,
      embeddingCount: result.embeddingCount,
      clearingStats,
    };
  } finally {
    await adapter.close();
  }
}

/**
 * Read graph status using DatabaseAdapter.
 * Requirements: 1.7, 7.3
 */
async function readGraphStatus(): Promise<GraphStatus> {
  const prefix = configurationManager.getPrefix();
  console.error(chalk.dim(`[typocop] Effective prefix: ${prefix}`));

  const config = configurationManager.getConfiguration();
  const adapter: DatabaseAdapter = await createDatabaseAdapter(config);

  try {
    const graphAdapter = adapter.getGraphAdapter();

    // Count symbols using prefixed label
    const symbolRows = await graphAdapter.runCypher<{ count: number }>(
      `MATCH (s:${prefix}Symbol) RETURN count(s) as count`,
    );
    const symbolCount = symbolRows[0]?.count ?? 0;

    // Count relationships
    const relRows = await graphAdapter.runCypher<{ count: number }>(
      `MATCH (:${prefix}Symbol)-[r]->(:\`${prefix}Symbol\`) RETURN count(r) as count`,
    );
    const relationshipCount = relRows[0]?.count ?? 0;

    // Get last indexed timestamp using prefixed label
    const tsRows = await graphAdapter.runCypher<{ timestamp: string | null }>(
      `MATCH (m:${prefix}Metadata {key: 'lastIndexed'}) RETURN m.timestamp as timestamp`,
    );
    const lastIndexed = tsRows[0]?.timestamp ?? null;

    return { symbolCount, relationshipCount, lastIndexed };
  } finally {
    await adapter.close();
  }
}

/**
 * Configure HuggingFace embeddings and download model.
 */
async function configureHuggingFaceEmbeddings(): Promise<void> {
  const fs = await import("fs");
  const path = await import("path");
  const { execSync } = await import("child_process");

  const envPath = ".env-typocop";

  // Read current .env-typocop
  let envContent = fs.readFileSync(envPath, "utf-8");

  // Update EMBEDDING_PROVIDER to huggingface
  envContent = envContent.replace(
    /EMBEDDING_PROVIDER=.*/,
    "EMBEDDING_PROVIDER=huggingface"
  );

  // Write back to file
  fs.writeFileSync(envPath, envContent, "utf-8");

  console.error(chalk.green("✓ Updated .env-typocop: EMBEDDING_PROVIDER=huggingface"));

  // Download HuggingFace model for caching
  const spinner = ora("Downloading HuggingFace embedding model...").start();

  try {
    // Use transformers.js to download and cache the model
    const { env } = await import("process");
    
    // Set cache directory for transformers
    const cacheDir = path.join(process.env.HOME || "~", ".cache", "huggingface", "transformers");
    env.HF_HOME = path.join(process.env.HOME || "~", ".cache", "huggingface");

    // Import and initialize the model to trigger download
    const { AutoTokenizer, AutoModel } = await import("@huggingface/transformers");
    
    // Download Xenova/bge-small-en-v1.5 (lightweight, fast embedding model)
    const modelName = "Xenova/bge-small-en-v1.5";
    
    spinner.text = `Downloading ${modelName}...`;
    
    await AutoTokenizer.from_pretrained(modelName);
    await AutoModel.from_pretrained(modelName);

    spinner.succeed(chalk.green(`✓ Model cached: ${modelName}`));
    console.error(chalk.dim(`  Cache location: ${cacheDir}`));
  } catch (err) {
    spinner.fail(chalk.red("Failed to download model"));
    throw err;
  }
}

export async function executeCLI(command: CLICommand): Promise<void> {
  switch (command.type) {
    case "hf": {
      console.error(chalk.blue("Configuring HuggingFace embeddings provider..."));
      await configureHuggingFaceEmbeddings();
      console.error(chalk.green("\n✓ HuggingFace embeddings configured successfully!"));
      console.error(chalk.dim("  Run 'typocop parse' to start indexing with embeddings."));
      break;
    }
    case "parse": {
      const { sourcePath, language, verbose, refresh } = command.config;
      console.error(chalk.blue(`Initializing indexing for ${language} codebase at ${sourcePath}`));

      const initialMessage = refresh
        ? "Clearing existing data and starting multi-phase indexing pipeline..."
        : "Starting multi-phase indexing pipeline...";

      const spinner = ora(initialMessage).start();

      try {
        if (verbose) {
          spinner.info("Verbose mode enabled.");
          if (refresh) {
            console.error(chalk.yellow("[typocop] Refresh flag enabled: clearing existing graph and vector data..."));
          }
        }

        const stats = await executeIndexingPipeline(sourcePath, language, verbose, refresh);

        spinner.succeed(chalk.green("Indexing completed successfully."));

        if (refresh && stats.clearingStats) {
          console.error(chalk.bold("\nClearing Statistics:"));
          console.error(`  Nodes deleted:         ${chalk.yellow(stats.clearingStats.nodesDeleted)}`);
          console.error(`  Relationships deleted: ${chalk.yellow(stats.clearingStats.relationshipsDeleted)}`);
          console.error(`  Embeddings deleted:    ${chalk.yellow(stats.clearingStats.embeddingsDeleted)}`);
        }

        console.error(chalk.bold("\nIndexing Statistics:"));
        console.error(`  Symbols:       ${chalk.cyan(stats.symbolCount)}`);
        console.error(`  Relationships: ${chalk.cyan(stats.relationshipCount)}`);
        console.error(`  Clusters:      ${chalk.cyan(stats.clusterCount)}`);
        console.error(`  Processes:     ${chalk.cyan(stats.processCount)}`);
        console.error(`  Embeddings:    ${chalk.cyan(stats.embeddingCount)}`);

        if (stats.skippedFiles > 0) {
          console.error(chalk.yellow(`  Skipped files: ${stats.skippedFiles} (syntax errors or unreadable)`));
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
        await executeIndexingPipeline(command.dbPath, "typescript", false);
        spinner.succeed(chalk.green("Reindexing complete."));
      } catch (err) {
        spinner.fail(chalk.red("Reindexing failed."));
        throw err;
      }
      break;
    }

    case "status": {
      const status = await readGraphStatus();
      console.error(chalk.bold("Knowledge Graph Status:"));
      console.error(`  Last Indexed:  ${chalk.cyan(status.lastIndexed ?? "never")}`);
      console.error(`  Symbols:       ${chalk.cyan(status.symbolCount)}`);
      console.error(`  Relationships: ${chalk.cyan(status.relationshipCount)}`);
      break;
    }

    case "obsidian": {
      const { outputPath, verbose } = command.config;
      console.error(chalk.blue(`Exporting knowledge graph to Obsidian vault at ${outputPath}`));

      const spinner = ora("Exporting graph to Obsidian vault...").start();

      try {
        if (verbose) {
          spinner.info("Verbose mode enabled.");
        }

        const adapterConfig = configurationManager.getConfiguration();
        const adapter = await createDatabaseAdapter(adapterConfig);
        try {
          const result = await executeObsidianExport(command.config, adapter);

          spinner.succeed(chalk.green("Obsidian vault export completed."));
          console.error(chalk.bold("\nExport Statistics:"));
          console.error(`  Files written:       ${chalk.cyan(result.filesWritten)}`);
          console.error(`  Directories created: ${chalk.cyan(result.directoriesCreated)}`);
          console.error(`  Total bytes:         ${chalk.cyan(result.totalBytes)}`);
        } finally {
          await adapter.close();
        }
      } catch (err) {
        spinner.fail(chalk.red("Obsidian export failed."));
        throw err;
      }
      break;
    }
  }
}
