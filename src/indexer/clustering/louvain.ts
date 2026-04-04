/**
 * Louvain community detection algorithm.
 *
 * Iteratively moves nodes between communities to maximise modularity.
 * Returns a list of communities (each a string[] of node IDs).
 * Singleton communities (< 2 members) are filtered out.
 *
 * Requirements: 3.4, 6.2, 21.5
 */
import type { ClusterGraph } from "./graph.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Community {
  /** Node IDs belonging to this community. */
  readonly members: string[];
  /** Modularity contribution — used as confidence score. */
  readonly modularity: number;
}

// ─── Louvain ──────────────────────────────────────────────────────────────────

/**
 * Run Louvain community detection on the given graph.
 *
 * Algorithm:
 * 1. Assign each node to its own community.
 * 2. For each node, try moving it to a neighbour's community if it improves
 *    modularity. Repeat until no improvement is found (one pass).
 * 3. Repeat passes until stable.
 * 4. Filter out singleton communities (< 2 members).
 * 5. Calculate per-community modularity contribution as confidence.
 *
 * Requirements: 3.4, 6.2, 21.5
 */
export function louvainClustering(graph: ClusterGraph): Community[] {
  const { nodes, adjacency, edgeCount } = graph;
  const nodeIds = Array.from(nodes.keys());

  if (nodeIds.length === 0 || edgeCount === 0) return [];

  const m = edgeCount; // total edges (each counted once)
  const m2 = 2 * m;   // 2m — denominator in modularity formula

  // community[nodeId] = communityId (initially each node is its own community)
  const community = new Map<string, string>();
  for (const id of nodeIds) community.set(id, id);

  // Degree of each node
  const degree = new Map<string, number>();
  for (const id of nodeIds) {
    degree.set(id, adjacency.get(id)?.size ?? 0);
  }

  // Sum of degrees of nodes in each community (Σ_tot)
  const communityDegreeSum = new Map<string, number>();
  for (const id of nodeIds) {
    communityDegreeSum.set(id, degree.get(id) ?? 0);
  }

  // Internal edges within each community (Σ_in, counted as half-edges)
  const communityInternalEdges = new Map<string, number>();
  for (const id of nodeIds) communityInternalEdges.set(id, 0);

  let improved = true;
  const MAX_PASSES = 20;
  let pass = 0;

  while (improved && pass < MAX_PASSES) {
    improved = false;
    pass++;

    for (const nodeId of nodeIds) {
      const currentComm = community.get(nodeId)!;
      const ki = degree.get(nodeId) ?? 0;
      if (ki === 0) continue;

      // Count edges from nodeId to each neighbouring community
      const commEdges = new Map<string, number>();
      const neighbours = adjacency.get(nodeId) ?? new Set();
      for (const nb of neighbours) {
        const nbComm = community.get(nb)!;
        commEdges.set(nbComm, (commEdges.get(nbComm) ?? 0) + 1);
      }

      // Temporarily remove nodeId from its current community
      const kInCurrent = commEdges.get(currentComm) ?? 0;
      const sigmaTotCurrent =
        (communityDegreeSum.get(currentComm) ?? 0) - ki;
      communityDegreeSum.set(currentComm, sigmaTotCurrent);
      communityInternalEdges.set(
        currentComm,
        (communityInternalEdges.get(currentComm) ?? 0) - kInCurrent,
      );

      // Compute gain for each candidate community (including current)
      // ΔQ(add) = k_in/m - (Σ_tot * k_i) / (2m²)
      let bestComm = currentComm;
      // Gain of re-inserting into current community (after removal)
      let bestGain =
        kInCurrent / m - (sigmaTotCurrent * ki) / (m2 * m);

      for (const [candidateComm, kIn] of commEdges) {
        if (candidateComm === currentComm) continue;
        const sigmaTot = communityDegreeSum.get(candidateComm) ?? 0;
        const gain = kIn / m - (sigmaTot * ki) / (m2 * m);
        if (gain > bestGain) {
          bestGain = gain;
          bestComm = candidateComm;
        }
      }

      // Move to best community
      community.set(nodeId, bestComm);
      const kInBest = commEdges.get(bestComm) ?? 0;
      communityDegreeSum.set(
        bestComm,
        (communityDegreeSum.get(bestComm) ?? 0) + ki,
      );
      communityInternalEdges.set(
        bestComm,
        (communityInternalEdges.get(bestComm) ?? 0) + kInBest,
      );

      if (bestComm !== currentComm) improved = true;
    }
  }

  // Group nodes by community
  const groups = new Map<string, string[]>();
  for (const [nodeId, commId] of community) {
    const group = groups.get(commId);
    if (group) {
      group.push(nodeId);
    } else {
      groups.set(commId, [nodeId]);
    }
  }

  // Build Community objects, filtering singletons
  const communities: Community[] = [];
  for (const [commId, members] of groups) {
    if (members.length < 2) continue; // Req 6.4 — min 2 symbols

    const sigmaTot = communityDegreeSum.get(commId) ?? 0;
    const sigmaIn = communityInternalEdges.get(commId) ?? 0;

    // Modularity contribution: [Σ_in/m - (Σ_tot/2m)²]
    const modContrib = sigmaIn / m - Math.pow(sigmaTot / m2, 2);
    // Clamp to [0, 1] and use as confidence
    const modularity = Math.min(1.0, Math.max(0.0, modContrib));

    communities.push({ members, modularity });
  }

  return communities;
}

/**
 * Generate a heuristic label for a community from member file paths and names.
 * Ported from legacy community-processor.generateHeuristicLabel.
 */
export function generateHeuristicLabel(
  members: string[],
  nodePathMap: Map<string, string>,
  nodeNameMap: Map<string, string>,
  communityIndex: number,
): string {
  const GENERIC_FOLDERS = new Set([
    "src", "lib", "core", "utils", "common", "shared", "helpers",
  ]);

  // Count folder occurrences
  const folderCounts = new Map<string, number>();
  for (const id of members) {
    const filePath = nodePathMap.get(id) ?? "";
    const parts = filePath.split("/").filter(Boolean);
    if (parts.length >= 2) {
      const folder = parts[parts.length - 2];
      if (!GENERIC_FOLDERS.has(folder.toLowerCase())) {
        folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
      }
    }
  }

  // Most common folder
  let bestFolder = "";
  let maxCount = 0;
  for (const [folder, count] of folderCounts) {
    if (count > maxCount) {
      maxCount = count;
      bestFolder = folder;
    }
  }
  if (bestFolder) {
    return bestFolder.charAt(0).toUpperCase() + bestFolder.slice(1);
  }

  // Common name prefix fallback
  const names = members.map((id) => nodeNameMap.get(id) ?? "").filter(Boolean);
  if (names.length > 2) {
    const prefix = findCommonPrefix(names);
    if (prefix.length > 2) {
      return prefix.charAt(0).toUpperCase() + prefix.slice(1);
    }
  }

  return `Cluster_${communityIndex}`;
}

function findCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return "";
  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    while (!strings[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (prefix.length === 0) return "";
    }
  }
  return prefix;
}
