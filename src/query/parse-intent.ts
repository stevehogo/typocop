/**
 * Query intent classification.
 * Requirements: 9.1, 9.2, 11b.1, 21.6
 */
import type { QueryIntent } from "../types/index.js";
import { classifyIntent } from "../enrichment/intent.js";

/**
 * Parse natural language query text into a QueryIntent.
 * Delegates to AI Context Enrichment classifyIntent.
 * Confidence is always >= 0.7 (Req 9.2, 21.6).
 * Requirements: 9.1, 9.2, 11b.1, 21.6
 */
export function parseQueryIntent(text: string): { intent: QueryIntent; confidence: number } {
  return classifyIntent(text);
}
