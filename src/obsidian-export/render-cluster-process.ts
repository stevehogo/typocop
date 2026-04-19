/**
 * Cluster, Process, and Navigation renderers for Obsidian vault export.
 * Requirements: 4.1–4.4, 5.1–5.5, 6.1–6.4
 */
import type {
  ExportedCluster,
  ExportedProcess,
  ExportedProcessStep,
  ExportedSymbol,
  GraphData,
} from "./graph-reader.js";
import { slugify, sourcePathToVaultPath } from "./render-symbol.js";

function sanitizeMermaidId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Requirement 4.1–4.3: Cluster file with frontmatter and member wikilinks */
export function renderClusterFile(cluster: ExportedCluster, members: readonly ExportedSymbol[]): string {
  const lines = [
    "---",
    "type: cluster",
    `category: ${cluster.category}`,
    `confidence: ${cluster.confidence}`,
    `symbol_count: ${members.length}`,
    "---",
    "",
    `# Cluster: ${cluster.name}`,
    "",
    `**Category**: ${cluster.category}  |  **Confidence**: ${cluster.confidence}  |  **Symbols**: ${members.length}`,
    "",
    "## Members",
    "",
    ...members.map((m) => `- [[${sourcePathToVaultPath(m.filePath)}]] > \`${m.name}\``),
    "",
  ];
  return lines.join("\n");
}

/** Requirement 4.4: Cluster index listing all clusters */
export function renderClusterIndex(clusters: readonly ExportedCluster[]): string {
  const lines = [
    "---",
    "type: cluster-index",
    `cluster_count: ${clusters.length}`,
    "---",
    "",
    "# Clusters",
    "",
    ...clusters.map((c) => `- [[${slugify(c.name)}]] (${c.category}, ${c.symbolCount} symbols)`),
    "",
  ];
  return lines.join("\n");
}

function buildMermaidDiagram(steps: readonly ExportedProcessStep[]): string {
  if (steps.length === 0) return "";

  const lines = ["```mermaid", "graph LR"];
  const sortedSteps = [...steps].sort((a, b) => a.order - b.order);

  for (let i = 0; i < sortedSteps.length - 1; i++) {
    const fromLabel = String.fromCharCode(65 + i);
    const toLabel = String.fromCharCode(65 + i + 1);
    const fromName = sortedSteps[i].symbolName;
    const toName = sortedSteps[i + 1].symbolName;
    lines.push(`    ${fromLabel}[${sanitizeMermaidId(fromName)}] --> ${toLabel}[${sanitizeMermaidId(toName)}]`);
  }

  lines.push("```");
  return lines.join("\n");
}

/** Requirements 5.1–5.4: Process file with Mermaid diagram and step listing */
export function renderProcessFile(process: ExportedProcess, steps: readonly ExportedProcessStep[]): string {
  const sortedSteps = [...steps].sort((a, b) => a.order - b.order);

  const lines = [
    "---",
    "type: process",
    `entry_point: ${process.entryPoint}`,
    `step_count: ${sortedSteps.length}`,
    "---",
    "",
    `# Process: ${process.name}`,
    "",
    `**Entry Point**: [[${process.entryPoint}]]  |  **Steps**: ${sortedSteps.length}`,
    "",
  ];

  if (sortedSteps.length > 1) {
    lines.push("## Data Flow", "", buildMermaidDiagram(sortedSteps), "");
  }

  lines.push("## Steps", "");
  for (const step of sortedSteps) {
    lines.push(`${step.order + 1}. [[${step.symbolName}]]`);
  }
  lines.push("");

  return lines.join("\n");
}

/** Requirement 5.5: Process index listing all processes */
export function renderProcessIndex(processes: readonly ExportedProcess[]): string {
  const lines = [
    "---",
    "type: process-index",
    `process_count: ${processes.length}`,
    "---",
    "",
    "# Processes",
    "",
    ...processes.map((p) => `- [[${slugify(p.name)}]] (${p.stepCount} steps)`),
    "",
  ];
  return lines.join("\n");
}

/** Requirements 6.1–6.4: Navigation index with stats and source directories */
export function renderNavigationIndex(data: GraphData): string {
  const sourceDirectories = extractSourceDirectories(data.symbols);

  const lines = [
    "---",
    "type: navigation",
    `symbol_count: ${data.symbols.length}`,
    `cluster_count: ${data.clusters.length}`,
    `process_count: ${data.processes.length}`,
    "---",
    "",
    "# Code Graph Navigator",
    "",
    `**Symbols**: ${data.symbols.length}  |  **Clusters**: ${data.clusters.length}  |  **Processes**: ${data.processes.length}`,
    "",
    "## Quick Links",
    "",
    "- [[_clusters/_index|Clusters]]",
    "- [[_processes/_index|Processes]]",
    "",
    "## Source Directories",
    "",
    ...sourceDirectories.map((dir) => `- [[${dir}]]`),
    "",
  ];
  return lines.join("\n");
}

function extractSourceDirectories(symbols: readonly ExportedSymbol[]): string[] {
  const dirs = new Set<string>();
  for (const symbol of symbols) {
    const lastSlash = symbol.filePath.lastIndexOf("/");
    if (lastSlash > 0) {
      dirs.add(symbol.filePath.slice(0, lastSlash));
    }
  }
  return [...dirs].sort();
}
