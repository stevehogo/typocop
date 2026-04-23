/**
 * Embedding text formatters for symbols and clusters.
 * PRIVACY: Only symbol metadata is included, never full source code.
 * Requirements: 22.1, 22.2
 */
import type { Symbol, Cluster } from "../../types/index.js";
import { verifyEmbeddingText } from "../../security/privacy.js";

/**
 * Formats a symbol into a text string suitable for embedding.
 * Includes name, kind, signature, documentation, file context, and semantic tags.
 *
 * PRIVACY: Only symbol metadata is included, never full source code.
 * Requirements: 22.2
 */
export function formatSymbolForEmbedding(symbol: Symbol): string {
  const parts: string[] = [
    `${symbol.kind}: ${symbol.name}`,
  ];
  if (symbol.location?.filePath) {
    const filePath = symbol.location.filePath;
    const pathParts = filePath.split('/');
    if (pathParts.length > 1) {
      const module = pathParts.slice(0, -1).join('/');
      parts.push(`module: ${module}`);
    }
  }

  if (symbol.signature) {
    parts.push(`signature: ${symbol.signature}`);
  }
  if (symbol.documentation) {
    parts.push(`docs: ${symbol.documentation}`);
  }
  parts.push(`visibility: ${symbol.visibility}`);
  if (symbol.modifiers.length > 0) {
    parts.push(`modifiers: ${symbol.modifiers.join(", ")}`);
  }

  const formatted = parts.join("\n");
  verifyEmbeddingText(formatted, `symbol ${symbol.name}`);
  return formatted;
}

/**
 * Formats a cluster and its resolved symbols into a text string for embedding.
 *
 * PRIVACY: Only cluster metadata and symbol names/kinds are included.
 * Requirements: 22.2
 */
export function formatClusterForEmbedding(cluster: Cluster, symbols: Symbol[]): string {
  const parts: string[] = [
    `cluster: ${cluster.name}`,
    `category: ${cluster.category}`,
    `confidence: ${cluster.confidence.toFixed(2)}`,
  ];

  if (symbols.length > 0) {
    const symbolDetails = symbols
      .map(s => {
        const details = [`${s.kind} ${s.name}`];
        if (s.location?.filePath) {
          const module = s.location.filePath.split('/').slice(0, -1).join('/');
          details.push(`(${module})`);
        }
        return details.join(' ');
      })
      .join(", ");
    parts.push(`symbols: ${symbolDetails}`);

    const semanticTags = new Set<string>();
    for (const s of symbols) {
      const nameWords = s.name.toLowerCase().split(/[_-]/);
      for (const word of nameWords) {
        if (word.length > 3) semanticTags.add(word);
      }
      semanticTags.add(s.kind);
    }

    if (semanticTags.size > 0) {
      parts.push(`tags: ${Array.from(semanticTags).join(", ")}`);
    }
  }

  const formatted = parts.join("\n");
  verifyEmbeddingText(formatted, `cluster ${cluster.name}`);
  return formatted;
}
