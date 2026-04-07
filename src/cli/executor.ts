import type { Driver, Session } from "neo4j-driver";
import type { Pool } from "pg";
import { CLICommand } from "./parser.js";
import chalk from "chalk";
import ora from "ora";
import { createDriver } from "../graph/connection.js";
import { createPool, initVectorStore } from "../vector/connection.js";
import { runIndexingPipeline, type PipelineConfig } from "../indexer/pipeline.js";
import { configurationManager } from "../config/index.js";

export interface IndexingStats {
  symbolCount: number;
  relationshipCount: number;
  clusterCount: number;
  processCount: number;
  skippedFiles: number;
  embeddingCount: number;
}

export interface GraphStatus {
  symbolCount: number;
  relationshipCount: number;
  lastIndexed: string | null;
}

/**
 * Get database configuration from environment variables.
 * Requirements: 22.1
 */
function getDatabaseConfig() {
  const neo4jUri = process.env.NEO4J_URI || "bolt://localhost:8687";
  const neo4jUser = process.env.NEO4J_USER || "neo4j";
  const neo4jPassword = process.env.NEO4J_PASSWORD || "password";
  
  const pgHost = process.env.POSTGRES_HOST || "localhost";
  const pgPort = parseInt(process.env.POSTGRES_PORT || "8432", 10);
  const pgDatabase = process.env.POSTGRES_DB || "typocop";
  const pgUser = process.env.POSTGRES_USER || "postgres";
  const pgPassword = process.env.POSTGRES_PASSWORD || "password";

  return {
    neo4j: { uri: neo4jUri, user: neo4jUser, password: neo4jPassword },
    postgres: { host: pgHost, port: pgPort, database: pgDatabase, user: pgUser, password: pgPassword },
  };
}

/**
 * Execute the indexing pipeline with database connections.
 * Requirements: 1.1, 3.1–3.8, 7.2, 7.4
 */
async function executeIndexingPipeline(
  sourcePath: string,
  language: string,
  verbose: boolean
): Promise<IndexingStats> {
  const prefix = configurationManager.getPrefix();
  console.log(chalk.dim(`[typocop] Effective prefix: ${prefix}`));

  const config = getDatabaseConfig();
  
  // Create database connections
  const driver = await createDriver(config.neo4j.uri, config.neo4j.user, config.neo4j.password);
  const pool = await createPool(config.postgres);
  
  try {
    // Initialize vector store
    await initVectorStore(pool, prefix);
    
    const session = driver.session();
    try {
      const pipelineConfig: PipelineConfig = {
        sourcePath,
        language: language as any,
        verbose,
        graphSession: session,
        vectorPool: pool,
      };
      
      const result = await runIndexingPipeline(pipelineConfig);
      
      return {
        symbolCount: result.symbols.length,
        relationshipCount: result.relationships.length,
        clusterCount: result.clusters.length,
        processCount: result.processes.length,
        skippedFiles: result.skippedFiles,
        embeddingCount: result.embeddingCount,
      };
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
    await pool.end();
  }
}

/**
 * Read graph status from Neo4j.
 * Requirements: 1.7, 7.3
 */
async function readGraphStatus(_dbPath?: string): Promise<GraphStatus> {
  const prefix = configurationManager.getPrefix();
  console.log(chalk.dim(`[typocop] Effective prefix: ${prefix}`));

  const config = getDatabaseConfig();
  const driver = await createDriver(config.neo4j.uri, config.neo4j.user, config.neo4j.password);
  
  try {
    const session = driver.session();
    try {
      // Count symbols using prefixed label
      const symbolResult = await session.run(
        `MATCH (s:${prefix}Symbol) RETURN count(s) as count`
      );
      const symbolCount = symbolResult.records[0]?.get("count").toNumber() || 0;
      
      // Count relationships
      const relResult = await session.run("MATCH ()-[r]->() RETURN count(r) as count");
      const relationshipCount = relResult.records[0]?.get("count").toNumber() || 0;
      
      // Get last indexed timestamp using prefixed label
      const timestampResult = await session.run(
        `MATCH (m:${prefix}Metadata {key: 'lastIndexed'}) RETURN m.timestamp as timestamp`
      );
      const lastIndexed = timestampResult.records[0]?.get("timestamp") || null;
      
      return {
        symbolCount,
        relationshipCount,
        lastIndexed,
      };
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
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

        const stats = await executeIndexingPipeline(sourcePath, language, verbose);

        spinner.succeed(chalk.green("Indexing completed successfully."));
        console.log(chalk.bold("\nStatistics:"));
        console.log(`  Symbols:       ${chalk.cyan(stats.symbolCount)}`);
        console.log(`  Relationships: ${chalk.cyan(stats.relationshipCount)}`);
        console.log(`  Clusters:      ${chalk.cyan(stats.clusterCount)}`);
        console.log(`  Processes:     ${chalk.cyan(stats.processCount)}`);
        console.log(`  Embeddings:    ${chalk.cyan(stats.embeddingCount)}`);

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
      console.log(chalk.bold("Knowledge Graph Status:"));
      console.log(`  Last Indexed:  ${chalk.cyan(status.lastIndexed ?? "never")}`);
      console.log(`  Symbols:       ${chalk.cyan(status.symbolCount)}`);
      console.log(`  Relationships: ${chalk.cyan(status.relationshipCount)}`);
      break;
    }
  }
}
