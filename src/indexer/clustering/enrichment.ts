/**
 * AI Context Enrichment for clusters.
 *
 * Generates descriptive names and classifies clusters into categories
 * using heuristic keyword matching (no external API required at index time).
 * When an AI client is provided, it calls the LLM for richer names.
 *
 * PRIVACY: Only symbol names and kinds are sent to AI services, never full code.
 *
 * Requirements: 3.4, 6.3, 6.4, 6.6, 22.2, 24.1, 24.2
 */
import type { Cluster, ClusterCategory, Symbol } from "../../types/index.js";
import type { EmbeddingAdapter } from "../../db/types.js";
import { verifyEnrichmentPrompt } from "../../security/privacy.js";
import {
  SemanticClusterClassifier,
  buildClusterText,
} from "./semantic-classifier.js";

// ─── Category keyword map ─────────────────────────────────────────────────────

const CATEGORY_KEYWORDS: Record<ClusterCategory, string[]> = {
  authentication: [
    "auth", "login", "logout", "token", "jwt", "session", "password",
    "credential", "oauth", "permission", "role", "guard", "acl",
  ],
  dataAccess: [
    "repository", "dao", "model", "entity", "schema", "migration",
    "query", "database", "db", "orm", "resource", "collection",
    "store", "persist", "record",
  ],
  businessLogic: [
    "service", "manager", "handler", "processor", "calculator",
    "validator", "workflow", "rule", "policy", "engine", "orchestrat",
  ],
  uiComponent: [
    "component", "view", "template", "render", "widget", "page",
    "layout", "form", "modal", "button", "input", "display",
  ],
  utility: [
    "util", "helper", "format", "parse", "convert", "transform",
    "sanitize", "encode", "decode", "hash", "crypto", "logger",
    "config", "constant", "enum",
  ],
  unknown: [],
};

// ─── Heuristic classification ─────────────────────────────────────────────────

/**
 * Classify a cluster into a category by scoring keyword matches against
 * symbol names. Returns the highest-scoring category, or "unknown".
 *
 * Requirements: 6.3, 24.2
 */
export function classifyCluster(
  symbolIds: string[],
  symbolMap: ReadonlyMap<string, Symbol>,
): ClusterCategory {
  const scores: Record<ClusterCategory, number> = {
    authentication: 0,
    dataAccess: 0,
    businessLogic: 0,
    uiComponent: 0,
    utility: 0,
    unknown: 0,
  };

  for (const id of symbolIds) {
    const sym = symbolMap.get(id);
    if (!sym) continue;
    const text = `${sym.name} ${sym.signature ?? ""}`.toLowerCase();

    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS) as [
      ClusterCategory,
      string[],
    ][]) {
      for (const kw of keywords) {
        if (text.includes(kw)) scores[category]++;
      }
    }
  }

  let best: ClusterCategory = "unknown";
  let bestScore = 0;
  for (const [cat, score] of Object.entries(scores) as [ClusterCategory, number][]) {
    if (cat === "unknown") continue;
    if (score > bestScore) {
      bestScore = score;
      best = cat;
    }
  }

  return best;
}

// ─── AI name inference ────────────────────────────────────────────────────────

/** Minimal interface for an AI text generator (avoids hard dependency on any provider). */
export interface AIClient {
  generateText(prompt: string): Promise<string>;
}

/**
 * Infer a descriptive cluster name.
 *
 * If an AI client is provided, calls the LLM with a concise prompt.
 * Falls back to the heuristic label when AI is unavailable or fails.
 *
 * PRIVACY: Only sends symbol names and kinds (max 20 symbols), never full code.
 *
 * Requirements: 6.6, 22.2, 24.1
 */
export async function inferClusterName(
  heuristicLabel: string,
  symbolIds: string[],
  symbolMap: ReadonlyMap<string, Symbol>,
  aiClient?: AIClient,
): Promise<string> {
  if (!aiClient) return heuristicLabel;

  const members = symbolIds
    .slice(0, 20)
    .map((id) => symbolMap.get(id))
    .filter((s): s is Symbol => s !== undefined)
    .map((s) => `${s.name} (${s.kind})`)
    .join(", ");

  const prompt =
    `You are a software architect. Name this code cluster in 2–4 words.\n` +
    `Heuristic: "${heuristicLabel}"\n` +
    `Members: ${members}\n` +
    `Reply with ONLY the name, no punctuation.`;

  // Verify no source code or file paths are in the prompt (Req 22.2)
  verifyEnrichmentPrompt(prompt, `cluster ${heuristicLabel}`);

  try {
    const raw = await aiClient.generateText(prompt);
    const name = raw.trim().replace(/["`']/g, "").slice(0, 60);
    return name.length > 0 ? name : heuristicLabel;
  } catch {
    return heuristicLabel;
  }
}

// ─── Cluster enrichment ───────────────────────────────────────────────────────

// ─── Shared semantic classifier instance ──────────────────────────────────────

let sharedClassifier: SemanticClusterClassifier | null = null;

/**
 * Enrich a cluster with an AI-generated name and category.
 *
 * When `embeddingAdapter?.isEnabled()` is true, uses semantic classification
 * via Ollama embeddings. Otherwise falls back to keyword-based classification.
 *
 * Enforces minimum cluster size of 2 symbols (Req 6.4).
 * Returns the cluster unchanged if it has fewer than 2 symbols.
 *
 * Requirements: 3.4, 6.3, 6.4, 6.6, 10.4, 24.1, 24.2
 */
export async function enrichCluster(
  cluster: Cluster,
  symbolMap: ReadonlyMap<string, Symbol>,
  heuristicLabel: string,
  aiClient?: AIClient,
  embeddingAdapter?: EmbeddingAdapter,
): Promise<Cluster> {
  // Enforce minimum cluster size invariant
  if (cluster.symbols.length < 2) return cluster;

  const name = await inferClusterName(
    heuristicLabel,
    cluster.symbols,
    symbolMap,
    aiClient,
  );

  let category: ClusterCategory;

  if (embeddingAdapter?.isEnabled()) {
    // Semantic classification via Ollama (Req 10.1, 10.4)
    if (!sharedClassifier || !sharedClassifier.isInitialized()) {
      sharedClassifier = new SemanticClusterClassifier();
      await sharedClassifier.initialize(embeddingAdapter);
    }
    const clusterText = buildClusterText(cluster.symbols, symbolMap);
    category = await sharedClassifier.classify(clusterText);
  } else {
    // Keyword fallback (Req 10.4)
    category = classifyCluster(cluster.symbols, symbolMap);
  }

  return { ...cluster, name, category };
}

/**
 * Reset the shared classifier instance. Useful for testing.
 * @internal
 */
export function resetSharedClassifier(): void {
  sharedClassifier = null;
}
