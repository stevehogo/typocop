/**
 * AI Context Enrichment for clusters.
 *
 * Generates descriptive names and classifies clusters into categories
 * using heuristic keyword matching (no external API required at index time).
 * When an AI client is provided, it calls the LLM for richer names.
 *
 * Requirements: 3.4, 6.3, 6.4, 6.6, 24.1, 24.2
 */
import type { Cluster, ClusterCategory, Symbol } from "../../types/index.js";

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

/** Minimal interface for an AI text generator (avoids hard OpenAI dependency). */
export interface AIClient {
  generateText(prompt: string): Promise<string>;
}

/**
 * Infer a descriptive cluster name.
 *
 * If an AI client is provided, calls the LLM with a concise prompt.
 * Falls back to the heuristic label when AI is unavailable or fails.
 *
 * Requirements: 6.6, 24.1
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

  try {
    const raw = await aiClient.generateText(prompt);
    const name = raw.trim().replace(/["`']/g, "").slice(0, 60);
    return name.length > 0 ? name : heuristicLabel;
  } catch {
    return heuristicLabel;
  }
}

// ─── Cluster enrichment ───────────────────────────────────────────────────────

/**
 * Enrich a cluster with an AI-generated name and heuristic category.
 *
 * Enforces minimum cluster size of 2 symbols (Req 6.4).
 * Returns the cluster unchanged if it has fewer than 2 symbols.
 *
 * Requirements: 3.4, 6.3, 6.4, 6.6, 24.1, 24.2
 */
export async function enrichCluster(
  cluster: Cluster,
  symbolMap: ReadonlyMap<string, Symbol>,
  heuristicLabel: string,
  aiClient?: AIClient,
): Promise<Cluster> {
  // Enforce minimum cluster size invariant
  if (cluster.symbols.length < 2) return cluster;

  const name = await inferClusterName(
    heuristicLabel,
    cluster.symbols,
    symbolMap,
    aiClient,
  );

  const category = classifyCluster(cluster.symbols, symbolMap);

  return { ...cluster, name, category };
}
