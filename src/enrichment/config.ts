/**
 * AI Context Enrichment — configuration and task types.
 * Requirements: 24.1, 24.2, 24.3, 24.4, 24.5
 */
import type { Symbol } from "../types/index.js";

export interface EnrichmentConfig {
  readonly embeddingModel: string;          // "text-embedding-3-large"
  readonly dimensions: number;              // 1536
  readonly enableIntentClassification: boolean;
  readonly enableSideEffectAnalysis: boolean;
  readonly enableTypeInference: boolean;
}

export type EnrichmentTask =
  | { type: "dependencyMapping";    symbols: Symbol[] }
  | { type: "intentClassification"; text: string }
  | { type: "sideEffectAnalysis";   symbol: Symbol }
  | { type: "typeInference";        symbol: Symbol };
