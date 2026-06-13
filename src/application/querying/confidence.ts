/**
 * Confidence score calculation for query results.
 * Requirements: 9.4, 21.2
 */
import type { Symbol, Relationship, QueryIntent, SearchResult } from "../../core/domain.js";

/**
 * Calculate confidence score based on similarity scores and result completeness.
 *
 * When semantic search results are available, blends the average cosine similarity
 * with a small structural bonus for results that also have graph relationships.
 * Falls back to a count-based heuristic for non-semantic query types.
 *
 * Requirements: 9.4, 21.2
 */
export function calculateConfidence(
  symbols: Symbol[],
  relationships: Relationship[],
  _intent: QueryIntent,
  searchResults?: Pick<SearchResult, "score">[],
): number {
  if (symbols.length === 0) return 0.5;

  // Score-based path: blend average similarity with a structural bonus
  if (searchResults && searchResults.length > 0) {
    const avgScore =
      searchResults.reduce((sum, r) => sum + r.score, 0) / searchResults.length;
    const structuralBonus = relationships.length > 0 ? 0.05 : 0.0;
    return Math.min(1.0, Math.max(0.5, avgScore + structuralBonus));
  }

  // Fallback: count-based heuristic for non-semantic query types
  if (relationships.length > 0) return 0.92;
  return 0.75;
}
