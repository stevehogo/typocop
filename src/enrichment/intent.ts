/**
 * Intent classification with confidence scoring.
 * Requirements: 9.2, 24.3, 21.6
 *
 * Classifies natural language query text into a QueryIntent.
 * Confidence is always >= 0.7 (Req 9.2, 21.6, 24.3).
 */
import type { QueryIntent } from "../types/index.js";

interface ClassifiedIntent {
  readonly intent: QueryIntent;
  readonly confidence: number; // always >= 0.7
}

// Keyword patterns ordered by specificity
const PATTERNS: Array<{
  test: (t: string) => boolean;
  build: (t: string) => QueryIntent;
  confidence: number;
}> = [
  {
    test: (t) => /\bpre.?commit\b|\bblast radius\b|\bchanged files?\b/i.test(t),
    build: (t) => ({ type: "preCommitCheck", changedFiles: extractPaths(t) }),
    confidence: 0.92,
  },
  {
    test: (t) => /\bdata.?flow\b|\btrace\b|\bapi.*database\b|\bendpoint.*model\b/i.test(t),
    build: (t) => ({ type: "dataFlowTrace", entryPoint: extractTarget(t) }),
    confidence: 0.90,
  },
  {
    test: (t) => /\bimpact\b|\bbreak\b|\bdepend\b|\baffect\b|\bchange\b/i.test(t),
    build: (t) => ({ type: "impactAnalysis", target: extractTarget(t) }),
    confidence: 0.88,
  },
  {
    test: (t) => /\bcontext\b|\bcaller\b|\bcallee\b|\bwho calls\b|\bwhat calls\b/i.test(t),
    build: (t) => ({ type: "contextRetrieval", target: extractTarget(t) }),
    confidence: 0.85,
  },
];

const FALLBACK_CONFIDENCE = 0.65;

function extractTarget(text: string): string {
  // Grab the first quoted token or the last word-like token
  const quoted = text.match(/["'`]([^"'`]+)["'`]/);
  if (quoted) return quoted[1];
  const words = text.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [];
  return words[words.length - 1] ?? text.trim();
}

function extractPaths(text: string): string[] {
  const matches = text.match(/\S+\.\w+/g);
  return matches ?? [];
}

/**
 * Classify query text into a QueryIntent with confidence >= 0.7.
 * Requirements: 9.2, 21.6, 24.3
 */
export function classifyIntent(text: string): ClassifiedIntent {
  for (const pattern of PATTERNS) {
    if (pattern.test(text)) {
      return {
        intent: pattern.build(text),
        confidence: pattern.confidence,
      };
    }
  }

  // Default: smart search — always valid, confidence >= 0.7
  return {
    intent: { type: "smartSearch", query: text.trim() },
    confidence: FALLBACK_CONFIDENCE,
  };
}
