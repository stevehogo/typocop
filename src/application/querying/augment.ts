/**
 * D1 — Auto-augmenting hook engine (keyword-only, fail-silent).
 *
 * Given a raw search pattern (the Grep/Glob/Bash term the agent is about to
 * run), produce a short human-readable `[typocop]` block describing the graph
 * context of the best-matching symbol(s): their callers, callees, owning
 * cluster, and the processes they participate in. This is the read-only path
 * the Claude Code PreToolUse hook spawns via the CLI `augment` subcommand.
 *
 * Design constraints (plan Part 4, D1):
 * - **Keyword-only.** No embeddings, no FTS (the repo has no FTS index), so
 *   resolution is a `CONTAINS` candidate scan over `n.name` reusing the same
 *   identifier-splitting (`splitIdentifier`/`extractKeywords`) as indexing.
 * - **Fast.** Bounded candidate scan, top 1–3 matches only, ≤3 of each
 *   relation per match, all under a single {@link withQueryTimeout}.
 * - **Fail-silent.** The ENTIRE body is wrapped in try/catch → `""`. An
 *   unknown pattern, a thrown adapter, or a timeout all return `""`, so the
 *   hook simply injects nothing — never an error.
 *
 * The marker (`[typocop]`) is added by the CLI when it writes the block to
 * stderr; this engine returns the marker-less body (or `""`).
 */

import type { GraphAdapter } from "../../core/ports/persistence.js";
import { withQueryTimeout } from "../../platform/utils/limits.js";
import { splitIdentifier } from "../../platform/utils/identifier.js";
import { executeContextRetrieval } from "./context-retrieval.js";

/** Max candidate symbols we resolve+enrich for one augment call. */
const MAX_MATCHES = 3;
/** Max callers/callees/clusters/processes surfaced per matched symbol. */
const MAX_PER_RELATION = 3;
/** Hard wall-clock budget for the whole augment query (ms). */
const AUGMENT_TIMEOUT_MS = 2_000;
/** Cap on the CONTAINS candidate scan so a hot keyword can't fan out. */
const CANDIDATE_SCAN_LIMIT = 50;

/** Shape of the candidate rows projected by the keyword CONTAINS scan. */
interface CandidateRow {
  readonly id: string;
  readonly name: string;
}

/**
 * Derive the search terms to probe the graph with. We reuse the indexing
 * identifier splitter so `getUserById` → `get user by id` matches the same way
 * the keyword index was built. The raw pattern is kept too (it may be a literal
 * symbol name the splitter would over-fragment). Terms shorter than 3 chars are
 * dropped — too noisy to be a useful CONTAINS probe.
 */
function deriveSearchTerms(pattern: string): string[] {
  const cleaned = pattern.trim();
  if (!cleaned) return [];
  const terms = new Set<string>();
  if (cleaned.length >= 3) terms.add(cleaned);
  for (const part of splitIdentifier(cleaned)) {
    if (part.length >= 3) terms.add(part);
  }
  return [...terms];
}

/**
 * Resolve up to {@link MAX_MATCHES} candidate symbols by a keyword CONTAINS
 * scan over `n.name` (case-insensitive). Shortest names first — closest to what
 * the agent typed — mirroring {@link resolveSymbol}'s shortest-match heuristic.
 */
async function findCandidates(
  graph: GraphAdapter,
  terms: readonly string[],
): Promise<CandidateRow[]> {
  if (terms.length === 0) return [];
  // One batched query: OR the lowercased CONTAINS probes. `toLower` keeps it
  // case-insensitive without an FTS index. LIMIT bounds the scan.
  const conditions = terms.map((_, i) => `toLower(n.name) CONTAINS $t${i}`).join(" OR ");
  const params: Record<string, unknown> = {};
  terms.forEach((t, i) => {
    params[`t${i}`] = t.toLowerCase();
  });
  const rows = await graph.runCypher<CandidateRow>(
    `MATCH (n:Symbol) WHERE ${conditions} RETURN n.id AS id, n.name AS name LIMIT ${CANDIDATE_SCAN_LIMIT}`,
    params,
  );
  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    if (!r.id || !r.name || seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
  unique.sort((a, b) => a.name.length - b.name.length);
  return unique.slice(0, MAX_MATCHES);
}

/** Render one matched symbol's context as a few indented lines. */
function renderMatch(
  name: string,
  callers: readonly string[],
  callees: readonly string[],
  clusters: readonly string[],
  processes: readonly string[],
): string {
  const lines: string[] = [`  ${name}`];
  if (callers.length > 0) lines.push(`    called by: ${callers.join(", ")}`);
  if (callees.length > 0) lines.push(`    calls: ${callees.join(", ")}`);
  if (clusters.length > 0) lines.push(`    cluster: ${clusters.join(", ")}`);
  if (processes.length > 0) lines.push(`    flows: ${processes.join(", ")}`);
  return lines.join("\n");
}

/**
 * Build the augment context block for a search `pattern`.
 *
 * Returns the marker-less block body, or `""` when there is nothing useful to
 * say (unknown pattern, no graph context) OR on ANY failure (thrown adapter,
 * timeout). The caller (CLI `augment`) prefixes the `[typocop]` marker.
 */
export async function augment(pattern: string, graph: GraphAdapter): Promise<string> {
  try {
    return await withQueryTimeout(async () => {
      const terms = deriveSearchTerms(pattern);
      if (terms.length === 0) return "";

      const candidates = await findCandidates(graph, terms);
      if (candidates.length === 0) return "";

      const blocks: string[] = [];
      for (const candidate of candidates) {
        // Reuse the 360° context retrieval: callers/callees/clusters/processes.
        const ctx = await executeContextRetrieval(candidate.id, 50, graph);
        if (ctx.resolution.kind === "not_found") continue;

        const targetId = candidate.id;
        const callers = ctx.relationships
          .filter((r) => r.relType === "calls" && r.target === targetId)
          .map((r) => symbolName(ctx.symbols, r.source))
          .filter((n): n is string => Boolean(n))
          .slice(0, MAX_PER_RELATION);
        const callees = ctx.relationships
          .filter((r) => r.relType === "calls" && r.source === targetId)
          .map((r) => symbolName(ctx.symbols, r.target))
          .filter((n): n is string => Boolean(n))
          .slice(0, MAX_PER_RELATION);
        const clusters = ctx.clusters.map((c) => c.name).slice(0, MAX_PER_RELATION);
        const processes = ctx.affectedFlows.slice(0, MAX_PER_RELATION);

        // Only surface a match that actually has graph context worth injecting.
        if (
          callers.length === 0 &&
          callees.length === 0 &&
          clusters.length === 0 &&
          processes.length === 0
        ) {
          continue;
        }
        blocks.push(renderMatch(candidate.name, callers, callees, clusters, processes));
      }

      if (blocks.length === 0) return "";
      return `Graph context for "${pattern}":\n${blocks.join("\n")}`;
    }, AUGMENT_TIMEOUT_MS);
  } catch {
    // Fail silent — the hook injects nothing rather than surfacing an error.
    return "";
  }
}

/** Resolve a symbol id to its display name from the retrieved symbol set. */
function symbolName(
  symbols: readonly { id: string; name: string }[],
  id: string,
): string | undefined {
  return symbols.find((s) => s.id === id)?.name;
}
