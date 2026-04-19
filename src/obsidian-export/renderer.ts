/**
 * MarkdownRenderer — transforms GraphData into Obsidian vault content.
 * Requirements: 3.1–5.5
 */
import type {
  ExportedCluster,
  ExportedRelationship,
  ExportedSymbol,
  GraphData,
} from "./graph-reader.js";
import {
  renderSymbolFile,
  slugify,
  sourcePathToVaultPath,
  type SymbolRenderContext,
} from "./render-symbol.js";
import {
  renderClusterFile,
  renderClusterIndex,
  renderNavigationIndex,
  renderProcessFile,
  renderProcessIndex,
} from "./render-cluster-process.js";

export type { SymbolRenderContext } from "./render-symbol.js";
export { renderSymbolFile, slugify, sourcePathToVaultPath } from "./render-symbol.js";
export {
  renderClusterFile,
  renderClusterIndex,
  renderNavigationIndex,
  renderProcessFile,
  renderProcessIndex,
} from "./render-cluster-process.js";

export interface VaultFile {
  readonly relativePath: string;
  readonly content: string;
}

export interface VaultContent {
  readonly files: VaultFile[];
}

export function renderVault(data: GraphData): VaultContent {
  const files: VaultFile[] = [];
  const symbolsByFile = groupBy(data.symbols, (s) => s.filePath);
  const symbolToCluster = buildSymbolToClusterMap(data.clusterMemberships, data.clusters);
  const callerCounts = buildCallerCountMap(data.relationships);
  const outgoingCalls = buildOutgoingCallsMap(data.relationships);
  const incomingCalls = buildIncomingCallsMap(data.relationships);

  const ctx: SymbolRenderContext = { symbolToCluster, callerCounts, outgoingCalls, incomingCalls };

  // Symbol files (one per source file)
  for (const [filePath, symbols] of symbolsByFile) {
    const mdPath = sourcePathToVaultPath(filePath);
    const content = renderSymbolFile(filePath, symbols, ctx);
    files.push({ relativePath: mdPath, content });
  }

  // Cluster files + index
  for (const cluster of data.clusters) {
    const members = (data.clusterMemberships.get(cluster.id) ?? [])
      .map((id) => data.symbols.find((s) => s.id === id))
      .filter((s): s is ExportedSymbol => s !== undefined);
    files.push({
      relativePath: `_clusters/${slugify(cluster.name)}.md`,
      content: renderClusterFile(cluster, members),
    });
  }
  files.push({ relativePath: "_clusters/_index.md", content: renderClusterIndex(data.clusters) });

  // Process files + index
  for (const process of data.processes) {
    const steps = data.processSteps.get(process.id) ?? [];
    files.push({
      relativePath: `_processes/${slugify(process.name)}.md`,
      content: renderProcessFile(process, steps),
    });
  }
  files.push({ relativePath: "_processes/_index.md", content: renderProcessIndex(data.processes) });

  // Top-level navigation
  files.push({ relativePath: "_index.md", content: renderNavigationIndex(data) });

  return { files };
}

// --- Utility: groupBy ---

export function groupBy<T>(items: readonly T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = map.get(key);
    if (group) {
      group.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}

// --- Reverse-lookup map builders ---

export function buildSymbolToClusterMap(
  memberships: ReadonlyMap<string, string[]>,
  clusters: readonly ExportedCluster[],
): Map<string, string> {
  const clusterById = new Map(clusters.map((c) => [c.id, c.name]));
  const result = new Map<string, string>();
  for (const [clusterId, symbolIds] of memberships) {
    const clusterName = clusterById.get(clusterId);
    if (!clusterName) continue;
    for (const symbolId of symbolIds) {
      result.set(symbolId, clusterName);
    }
  }
  return result;
}

export function buildCallerCountMap(relationships: readonly ExportedRelationship[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rel of relationships) {
    if (rel.relType === "CALLS") {
      counts.set(rel.targetId, (counts.get(rel.targetId) ?? 0) + 1);
    }
  }
  return counts;
}

export function buildOutgoingCallsMap(relationships: readonly ExportedRelationship[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const rel of relationships) {
    if (rel.relType === "CALLS") {
      const existing = map.get(rel.sourceId);
      if (existing) {
        existing.push(rel.targetName);
      } else {
        map.set(rel.sourceId, [rel.targetName]);
      }
    }
  }
  return map;
}

export function buildIncomingCallsMap(relationships: readonly ExportedRelationship[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const rel of relationships) {
    if (rel.relType === "CALLS") {
      const existing = map.get(rel.targetId);
      if (existing) {
        existing.push(rel.sourceName);
      } else {
        map.set(rel.targetId, [rel.sourceName]);
      }
    }
  }
  return map;
}


