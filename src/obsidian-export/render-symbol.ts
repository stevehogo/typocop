/**
 * Symbol file rendering — YAML frontmatter + symbol sections with wikilinks.
 * Requirements: 3.1–3.6
 */
import type { ExportedSymbol } from "./graph-reader.js";

export interface SymbolRenderContext {
  readonly symbolToCluster: ReadonlyMap<string, string>;
  readonly callerCounts: ReadonlyMap<string, number>;
  readonly outgoingCalls: ReadonlyMap<string, string[]>;
  readonly incomingCalls: ReadonlyMap<string, string[]>;
}

export function sourcePathToVaultPath(filePath: string): string {
  // Strip leading slash to ensure vault paths are always relative.
  // Neo4j may store absolute file paths (e.g. /home/user/project/src/app.ts).
  const relative = filePath.startsWith("/") ? filePath.slice(1) : filePath;
  return relative.replace(/\.[^.]+$/, ".md");
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function renderSymbolFile(
  filePath: string,
  symbols: readonly ExportedSymbol[],
  ctx: SymbolRenderContext,
): string {
  const clusters = uniqueClusters(symbols, ctx.symbolToCluster);
  const frontmatter = buildFrontmatter(filePath, symbols.length, clusters);
  const sections = symbols.map((s) => renderSymbolSection(s, ctx));
  return `${frontmatter}\n# ${filePath}\n\n${sections.join("\n")}`;
}

function uniqueClusters(
  symbols: readonly ExportedSymbol[],
  symbolToCluster: ReadonlyMap<string, string>,
): string[] {
  const seen = new Set<string>();
  for (const s of symbols) {
    const cluster = symbolToCluster.get(s.id);
    if (cluster) seen.add(cluster);
  }
  return [...seen].sort();
}

function buildFrontmatter(filePath: string, symbolCount: number, clusters: string[]): string {
  const lines = [
    "---",
    `source_file: ${filePath}`,
    `symbol_count: ${symbolCount}`,
    "clusters:",
    ...clusters.map((c) => `  - ${c}`),
    `last_exported: ${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}`,
    "---",
    "",
  ];
  return lines.join("\n");
}

function renderSymbolSection(symbol: ExportedSymbol, ctx: SymbolRenderContext): string {
  const cluster = ctx.symbolToCluster.get(symbol.id) ?? "uncategorized";
  const callers = ctx.callerCounts.get(symbol.id) ?? 0;
  const outgoing = ctx.outgoingCalls.get(symbol.id) ?? [];
  const incoming = ctx.incomingCalls.get(symbol.id) ?? [];

  const lines: string[] = [
    `## ${symbol.name}`,
    "",
    "| Property | Value |",
    "|----------|-------|",
    `| Kind | ${symbol.kind} |`,
    `| Visibility | ${symbol.visibility} |`,
    `| Lines | ${symbol.startLine}\u2013${symbol.endLine} |`,
    `| Signature | \`${symbol.signature}\` |`,
    `| Cluster | [[${cluster}]] |`,
    `| Callers | ${callers} |`,
    "",
  ];

  if (outgoing.length > 0) {
    lines.push(`**Calls**: ${outgoing.map((n) => `[[${n}]]`).join(", ")}`);
  }
  if (incoming.length > 0) {
    lines.push(`**Called by**: ${incoming.map((n) => `[[${n}]]`).join(", ")}`);
  }
  lines.push("");

  return lines.join("\n");
}
