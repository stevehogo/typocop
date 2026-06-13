/**
 * Obsidian Export — public API and orchestration.
 * Requirements: 1.1, 2.1–2.9, 9.1, 9.2
 */
import type { DatabaseAdapter } from "../../core/ports/persistence.js";
import { configurationManager, type ObsidianExportConfig } from "../../platform/config/index.js";
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

// --- Orchestrator ---

/**
 * Execute the full Obsidian export pipeline:
 * initialize adapter → read graph → render markdown → write vault.
 *
 * Requirements: 9.1 (retry via DatabaseAdapter), 9.2 (empty graph handling)
 */
export async function executeObsidianExport(
  config: ObsidianExportConfig,
  adapter: DatabaseAdapter,
): Promise<WriteResult> {
  const prefix = configurationManager.getPrefix();
  const graphAdapter = adapter.getGraphAdapter();

  const graphData = await fetchAllGraphData(graphAdapter, prefix);

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
}
