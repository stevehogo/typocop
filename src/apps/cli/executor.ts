/**
 * CLI executor — creates DatabaseAdapter and runs commands.
 * Requirements: 1.1, 3.1–3.8, 5.1, 7.1, 7.2, 7.4
 */
import { CLICommand } from "./parser.js";
import chalk from "chalk";
import ora from "ora";
import { createDatabaseAdapter } from "../../infrastructure/persistence/database-adapter.js";
import { createEmbeddingAdapterFromConfig } from "../../infrastructure/embeddings/embedding-factory.js";
import { runIndexingPipeline, type PipelineConfig } from "../../application/indexing/pipeline.js";
import { configurationManager } from "../../platform/config/index.js";
import type { DatabaseAdapter } from "../../core/ports/persistence.js";
import { executeObsidianExport } from "../../application/export-render/index.js";

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
  externalDependencyCount: number;
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
  const adapter: DatabaseAdapter = await createDatabaseAdapter(config, createEmbeddingAdapterFromConfig(config));

  // Create an AbortController for cancellation
  const abortController = new AbortController();
  let isShuttingDown = false;

  // Handle Ctrl+C gracefully
  const handleSignal = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.error(chalk.yellow("\n[typocop] Received interrupt signal. Cleaning up..."));
    abortController.abort();
    
    try {
      await adapter.close();
    } catch (err) {
      if (verbose) {
        console.error(chalk.dim(`[typocop] Error during cleanup: ${err instanceof Error ? err.message : String(err)}`));
      }
    }

    process.exit(130); // Standard exit code for SIGINT
  };

  const signalHandler = handleSignal.bind(null);
  process.on("SIGINT", signalHandler);

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
      const externalDependenciesDeleted = await graphAdapter.deleteNodesByLabel("ExternalDependency");
      await graphAdapter.deleteNodesByLabel("Metadata");

      const callsDeleted = await graphAdapter.deleteRelationshipsByType("CALLS");
      const importsDeleted = await graphAdapter.deleteRelationshipsByType("IMPORTS");
      const containsDeleted = await graphAdapter.deleteRelationshipsByType("CONTAINS");
      const hasStepDeleted = await graphAdapter.deleteRelationshipsByType("HAS_STEP");
      const dependsOnDeleted = await graphAdapter.deleteRelationshipsByType("DEPENDS_ON");

      // Clear vector data
      const embeddingsDeleted = await vectorAdapter.deleteAll();

      clearingStats = {
        nodesDeleted: symbolsDeleted + clustersDeleted + processesDeleted + externalDependenciesDeleted,
        relationshipsDeleted: callsDeleted + importsDeleted + containsDeleted + hasStepDeleted + dependsOnDeleted,
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
      externalDependencyCount: result.externalDependencyCount,
      skippedFiles: result.skippedFiles,
      embeddingCount: result.embeddingCount,
      clearingStats,
    };
  } finally {
    process.removeListener("SIGINT", signalHandler);
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
  const adapter: DatabaseAdapter = await createDatabaseAdapter(config, createEmbeddingAdapterFromConfig(config));

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
 * Configure Ollama embeddings.
 */
async function configureOllamaEmbeddings(url?: string): Promise<void> {
  const fs = await import("fs");
  const { execSync } = await import("child_process");

  const envPath = ".env-typocop";
  const ollamaUrl = url || "http://localhost:11434";

  // Read current .env-typocop
  let envContent = fs.readFileSync(envPath, "utf-8");

  // Update EMBEDDING_PROVIDER to ollama
  envContent = envContent.replace(
    /EMBEDDING_PROVIDER=.*/,
    "EMBEDDING_PROVIDER=ollama"
  );

  // Enable Ollama
  envContent = envContent.replace(
    /OLLAMA_ENABLED=.*/,
    "OLLAMA_ENABLED=true"
  );

  // Update Ollama URL if different from default
  if (ollamaUrl !== "http://localhost:11434") {
    envContent = envContent.replace(
      /OLLAMA_URL=.*/,
      `OLLAMA_URL=${ollamaUrl}`
    );
  }

  // Write back to file
  fs.writeFileSync(envPath, envContent, "utf-8");

  console.error(chalk.green("✓ Updated .env-typocop:"));
  console.error(chalk.green(`  EMBEDDING_PROVIDER=ollama`));
  console.error(chalk.green(`  OLLAMA_ENABLED=true`));
  console.error(chalk.green(`  OLLAMA_URL=${ollamaUrl}`));

  // Verify Ollama is accessible
  const spinner = ora("Verifying Ollama connection...").start();

  try {
    const response = await fetch(`${ollamaUrl}/api/tags`);
    
    if (!response.ok) {
      spinner.fail(chalk.yellow("⚠ Ollama server responded but may not be fully ready"));
      console.error(chalk.dim(`  Status: ${response.status}`));
      console.error(chalk.dim(`  Ensure Ollama is running: ollama serve`));
      return;
    }

    const data = await response.json() as { models?: Array<{ name: string }> };
    const models = data.models || [];

    spinner.succeed(chalk.green(`✓ Ollama connection verified`));
    
    if (models.length > 0) {
      console.error(chalk.dim(`  Available models: ${models.map(m => m.name).join(", ")}`));
    } else {
      console.error(chalk.yellow("  ⚠ No models found. Pull a model with: ollama pull mxbai-embed-large"));
    }
  } catch (err) {
    spinner.fail(chalk.yellow("⚠ Could not connect to Ollama"));
    console.error(chalk.dim(`  Make sure Ollama is running at ${ollamaUrl}`));
    console.error(chalk.dim(`  Start with: ollama serve`));
  }
}

/**
 * Configure HuggingFace embeddings and download model.
 */
async function configureHuggingFaceEmbeddings(): Promise<void> {
  const fs = await import("fs");
  const path = await import("path");
  const os = await import("os");

  const envPath = ".env-typocop";
  const homeDir = os.homedir();
  const hfHomeDir = path.join(homeDir, ".cache", "huggingface");
  const hfCacheDir = path.join(hfHomeDir, "transformers");

  // Read current .env-typocop
  let envContent = fs.readFileSync(envPath, "utf-8");

  // Update EMBEDDING_PROVIDER to huggingface
  envContent = envContent.replace(
    /EMBEDDING_PROVIDER=.*/,
    "EMBEDDING_PROVIDER=huggingface"
  );

  // Add or update HF_HOME cache directory
  if (envContent.includes("HF_HOME=")) {
    envContent = envContent.replace(
      /HF_HOME=.*/,
      `HF_HOME=${hfHomeDir}`
    );
  } else {
    // Add HF_HOME after EMBEDDING_PROVIDER
    envContent = envContent.replace(
      /EMBEDDING_PROVIDER=huggingface/,
      `EMBEDDING_PROVIDER=huggingface\nHF_HOME=${hfHomeDir}`
    );
  }

  // Write back to file
  fs.writeFileSync(envPath, envContent, "utf-8");

  console.error(chalk.green("✓ Updated .env-typocop:"));
  console.error(chalk.green(`  EMBEDDING_PROVIDER=huggingface`));
  console.error(chalk.green(`  HF_HOME=${hfHomeDir}`));

  // Download HuggingFace model for caching
  const spinner = ora("Downloading HuggingFace embedding model...").start();

  try {
    // Ensure cache directory exists
    await fs.promises.mkdir(hfCacheDir, { recursive: true });

    // Import transformers env API to configure caching
    const { env, AutoTokenizer, AutoModel } = await import("@huggingface/transformers");
    
    // Configure HuggingFace transformers caching
    env.cacheDir = hfCacheDir;
    env.allowRemoteModels = true;  // Allow downloading models
    env.useWasmCache = true;       // Enable WASM runtime caching for faster offline loads

    // Download mixedbread-ai/mxbai-embed-large-v1 (lightweight, fast embedding model)
    const modelName = "mixedbread-ai/mxbai-embed-large-v1";
    
    spinner.text = `Downloading ${modelName}...`;
    
    await AutoTokenizer.from_pretrained(modelName);
    await AutoModel.from_pretrained(modelName);

    spinner.succeed(chalk.green(`✓ Model cached: ${modelName}`));
    console.error(chalk.dim(`  Cache location: ${hfCacheDir}`));
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

    case "ollama": {
      console.error(chalk.blue("Configuring Ollama embeddings provider..."));
      await configureOllamaEmbeddings(command.url);
      console.error(chalk.green("\n✓ Ollama embeddings configured successfully!"));
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
        console.error(`  External deps: ${chalk.cyan(stats.externalDependencyCount)}`);
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
        const adapter = await createDatabaseAdapter(adapterConfig, createEmbeddingAdapterFromConfig(adapterConfig));
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
