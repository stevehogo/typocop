/**
 * Obsidian Export — public API and orchestration.
 * Requirements: 1.1, 2.1–2.9, 9.1, 9.2
 */
import type { ObsidianExportConfig } from "../cli/parser.js";
import { configurationManager } from "../config/index.js";
import { createDriver } from "../graph/connection.js";
import { fetchAllGraphData } from "./graph-reader.js";
import { renderVault } from "./renderer.js";
import { writeVault } from "./vault-writer.js";

// --- Public types ---

export interface WriteResult {
  readonly filesWritten: number;
  readonly directoriesCreated: number;
  readonly totalBytes: number;
}

// --- Re-exports ---

export type {
  ExportedSymbol,
  ExportedCluster,
  ExportedProcess,
  ExportedRelationship,
  ExportedProcessStep,
  GraphData,
} from "./graph-reader.js";

export type { VaultFile, VaultContent } from "./renderer.js";
export { renderVault } from "./renderer.js";
export { fetchAllGraphData } from "./graph-reader.js";
export { writeVault } from "./vault-writer.js";

// --- Neo4j config (inlined — only needs Neo4j, not Postgres) ---

function getNeo4jConfig(): { uri: string; user: string; password: string } {
  return {
    uri: process.env.NEO4J_URI || "bolt://localhost:8687",
    user: process.env.NEO4J_USER || "neo4j",
    password: process.env.NEO4J_PASSWORD || "password",
  };
}

// --- Orchestrator ---

/**
 * Execute the full Obsidian export pipeline:
 * connect → read graph → render markdown → write vault.
 *
 * Requirements: 9.1 (retry via createDriver), 9.2 (empty graph handling)
 */
export async function executeObsidianExport(config: ObsidianExportConfig): Promise<WriteResult> {
  const prefix = configurationManager.getPrefix();
  const neo4j = getNeo4jConfig();

  const driver = await createDriver(neo4j.uri, neo4j.user, neo4j.password);
  try {
    const session = driver.session();
    try {
      const graphData = await fetchAllGraphData(session, prefix);

      if (graphData.symbols.length === 0) {
        console.error("[obsidian] No symbols found. Run 'typocop parse' first.");
        return { filesWritten: 0, directoriesCreated: 0, totalBytes: 0 };
      }

      const vaultContent = renderVault(graphData);
      const result = await writeVault(config.outputPath, vaultContent);

      console.error(
        `[obsidian] Exported ${result.filesWritten} files (${result.totalBytes} bytes) to ${config.outputPath}`,
      );

      return result;
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
}
