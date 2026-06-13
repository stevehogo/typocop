/**
 * MarkdownRenderer — transforms GraphData into Obsidian vault content.
 * Requirements: 3.1–5.5
 */
import type {
  ExportedCluster,
  ExportedExternalDependency,
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

function renderExternalDependencyFile(
  dependency: ExportedExternalDependency,
  dependsOnEdges: readonly ExportedRelationship[],
  symbolToCluster: ReadonlyMap<string, string>,
): string {
  const aliases = dependency.aliases.split(",").map((alias) => alias.trim()).filter(Boolean);
  const dependents = dependsOnEdges.filter((edge) => edge.targetId === dependency.id);
  return [
    "---",
    "type: external-dependency",
    `ecosystem: ${dependency.ecosystem}`,
    `dependent_count: ${dependents.length}`,
    "---",
    "",
    `# External Dependency: ${dependency.name}`,
    "",
    `**Ecosystem**: ${dependency.ecosystem}`,
    "",
    "## Aliases",
    "",
    ...(aliases.length > 0 ? aliases.map((alias) => `- ${alias}`) : ["- None"]),
    "",
    "## Dependent Symbols",
    "",
    ...(dependents.length > 0
      ? dependents.map((edge) => {
        const clusterName = symbolToCluster.get(edge.sourceId) ?? "unclustered";
        return `- [[03-symbols/${slugify(clusterName)}/${slugify(edge.sourceName)}|${edge.sourceName}]]`;
      })
      : ["- None"]),
    "",
  ].join("\n");
}

export function renderVault(data: GraphData): VaultContent {
  const files: VaultFile[] = [];
  const symbolsByCluster = groupSymbolsByCluster(data.symbols, data.clusterMemberships, data.clusters);
  const symbolToCluster = buildSymbolToClusterMap(data.clusterMemberships, data.clusters);
  const callerCounts = buildCallerCountMap(data.relationships);
  const outgoingCalls = buildOutgoingCallsMap(data.relationships);
  const incomingCalls = buildIncomingCallsMap(data.relationships);

  const ctx: SymbolRenderContext = { symbolToCluster, callerCounts, outgoingCalls, incomingCalls };

  // Symbol files organized by cluster (not by source file path)
  for (const [clusterName, symbols] of symbolsByCluster) {
    for (const symbol of symbols) {
      const mdPath = `03-symbols/${slugify(clusterName)}/${slugify(symbol.name)}.md`;
      const content = renderSymbolFile(symbol.filePath, [symbol], ctx);
      files.push({ relativePath: mdPath, content });
    }
  }

  // Cluster files + index
  for (const cluster of data.clusters) {
    const members = (data.clusterMemberships.get(cluster.id) ?? [])
      .map((id) => data.symbols.find((s) => s.id === id))
      .filter((s): s is ExportedSymbol => s !== undefined);
    files.push({
      relativePath: `01-clusters/${slugify(cluster.name)}.md`,
      content: renderClusterFile(cluster, members),
    });
  }
  files.push({ relativePath: "01-clusters/_index.md", content: renderClusterIndex(data.clusters) });

  // Process files + index
  for (const process of data.processes) {
    const steps = data.processSteps.get(process.id) ?? [];
    files.push({
      relativePath: `02-processes/${slugify(process.name)}.md`,
      content: renderProcessFile(process, steps),
    });
  }
  files.push({ relativePath: "02-processes/_index.md", content: renderProcessIndex(data.processes) });

  for (const dependency of data.externalDependencies) {
    files.push({
      relativePath: `04-external-dependencies/${slugify(dependency.name)}.md`,
      content: renderExternalDependencyFile(dependency, data.dependsOnEdges, symbolToCluster),
    });
  }
  files.push({
    relativePath: "04-external-dependencies/_index.md",
    content: [
      "---",
      "type: external-dependency-index",
      `dependency_count: ${data.externalDependencies.length}`,
      "---",
      "",
      "# External Dependencies",
      "",
      ...data.externalDependencies.map((dependency) =>
        `- [[${slugify(dependency.name)}]] (${dependency.ecosystem})`,
      ),
      "",
    ].join("\n"),
  });

  // Top-level navigation (main MOC)
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

// --- Utility: groupSymbolsByCluster ---

export function groupSymbolsByCluster(
  symbols: readonly ExportedSymbol[],
  memberships: ReadonlyMap<string, string[]>,
  clusters: readonly ExportedCluster[],
): Map<string, ExportedSymbol[]> {
  const clusterById = new Map(clusters.map((c) => [c.id, c.name]));
  const symbolToClusterId = new Map<string, string>();

  // Build symbol -> cluster ID mapping
  for (const [clusterId, symbolIds] of memberships) {
    for (const symbolId of symbolIds) {
      symbolToClusterId.set(symbolId, clusterId);
    }
  }

  // Group symbols by cluster name
  const result = new Map<string, ExportedSymbol[]>();
  for (const symbol of symbols) {
    const clusterId = symbolToClusterId.get(symbol.id);
    const clusterName = clusterId ? clusterById.get(clusterId) : "unclustered";
    const name = clusterName || "unclustered";

    const group = result.get(name);
    if (group) {
      group.push(symbol);
    } else {
      result.set(name, [symbol]);
    }
  }

  return result;
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
