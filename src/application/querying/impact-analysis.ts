/**
 * Impact analysis query logic.
 * Requirements: 10.1, 10.2, 10.3, 10.8, 7.2, 1.1, 1.2, 1.4, 1.5
 */
import type { GraphAdapter, GraphNode } from "../../core/ports/persistence.js";
import { prop } from "../../core/ports/persistence.js";
import type { Symbol, Relationship, Process, QueryResult, RiskLevel } from "../../core/domain.js";
import { graphNodeToCluster } from "./process-helpers.js";
import { MAX_TRAVERSAL_DEPTH } from "../../platform/utils/limits.js";
import { rowToNode, graphNodeToSymbol } from "./graph-helpers.js";
import type { CypherNodeRow } from "./graph-helpers.js";
import { resolveSymbol, type SymbolResolution } from "./symbol-resolver.js";
import { explainAffectedNode, type AffectedNodeExplanation, type NodeDegree } from "./explainability.js";
import type { RelationType } from "../../core/domain.js";

/** Core component name patterns that elevate risk to CRITICAL. */
const CORE_COMPONENT_PATTERNS = [
  /auth/i, /payment/i, /checkout/i, /security/i, /session/i, /token/i,
];

function isCoreComponent(name: string): boolean {
  return CORE_COMPONENT_PATTERNS.some((p) => p.test(name));
}

/**
 * Calculate risk level from affected symbol count and component criticality.
 * Requirements: 10.4, 10.5, 10.6, 10.7
 */
export function calculateImpactRisk(affectedSymbols: Symbol[]): RiskLevel {
  const count = affectedSymbols.length;
  if (affectedSymbols.some((s) => isCoreComponent(s.name))) return "critical";
  if (count >= 11) return "high";
  if (count >= 3) return "medium";
  return "low";
}

// ─── Graph query helpers using GraphAdapter ───────────────────────────────────

interface CypherProcessRow {
  p: { labels: string[]; properties: Record<string, string> };
}

interface CypherClusterRow {
  c: { labels: string[]; properties: Record<string, string> };
}

interface CypherStepRow {
  symbolId: string;
  stepOrder: number;
  description: string | null;
}

interface CypherExternalDependencyRow {
  ext: { labels: string[]; properties: Record<string, string> };
}

/**
 * Clamp a requested traversal depth to (0, {@link MAX_TRAVERSAL_DEPTH}].
 * `undefined`/invalid/out-of-range → MAX_TRAVERSAL_DEPTH (the prior default).
 */
export function clampTraversalDepth(maxDepth?: number): number {
  if (maxDepth === undefined || !Number.isFinite(maxDepth) || maxDepth < 1) {
    return MAX_TRAVERSAL_DEPTH;
  }
  return Math.min(Math.floor(maxDepth), MAX_TRAVERSAL_DEPTH);
}

async function findDependents(
  graph: GraphAdapter,
  symbolId: string,
  maxDepth: number = MAX_TRAVERSAL_DEPTH,
): Promise<GraphNode[]> {
  const depth = clampTraversalDepth(maxDepth);
  const rows = await graph.runCypher<CypherNodeRow>(
    `MATCH (n:Symbol)-[e:CALLS*1..${depth}]->(t:Symbol) WHERE t.id = $val OR t.name = $val RETURN DISTINCT n`,
    { val: symbolId },
  ) ?? [];
  return rows.map(rowToNode);
}

/** Map a raw Cypher edge label (possibly prefixed, e.g. `tpc_CALLS`) to a RelationType. */
function edgeLabelToRelType(label: string): RelationType {
  const bare = label.includes("_") ? label.slice(label.lastIndexOf("_") + 1) : label;
  switch (bare.toUpperCase()) {
    case "CALLS": return "calls";
    case "IMPORTS": return "imports";
    case "INHERITS": return "inherits";
    case "IMPLEMENTS": return "implements";
    case "CONTAINS": return "contains";
    case "REFERENCES": return "references";
    case "DEFINES": return "defines";
    case "DEPENDS_ON": return "dependsOn";
    default: return "calls";
  }
}

/** Row for the 1-hop direct-caller query: a direct caller id + the edge type that links it. */
interface CypherDirectCallerRow {
  callerId: string;
  edgeType: string;
}

/**
 * Find the DIRECT (1-hop) callers of the target and the edge type that links
 * each one. These are the nodes that "break immediately" — hopDistance 1 — and
 * the edge type is the {@link AffectedNodeExplanation.entryEdge}.
 */
async function findDirectCallers(
  graph: GraphAdapter,
  symbolId: string,
): Promise<Map<string, RelationType>> {
  const rows = await graph.runCypher<CypherDirectCallerRow>(
    `MATCH (n:Symbol)-[e]->(t:Symbol)
     WHERE t.id = $val OR t.name = $val
     RETURN DISTINCT n.id AS callerId, label(e) AS edgeType`,
    { val: symbolId },
  ) ?? [];
  const map = new Map<string, RelationType>();
  for (const row of rows) {
    if (!row?.callerId) continue;
    // First edge type wins (a node may have several edge types to the target).
    if (!map.has(row.callerId)) {
      map.set(row.callerId, edgeLabelToRelType(row.edgeType ?? "CALLS"));
    }
  }
  return map;
}

/** Row for the batched hop-1 degree aggregate. */
interface CypherDegreeRow {
  id: string;
  inDegree: number | string | null;
  outDegree: number | string | null;
}

function toCount(v: number | string | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }
  return 0;
}

/**
 * Batched hop-1 in/out degree aggregate for a set of nodes (one query, not N).
 * Used to classify each affected node's structural role (D2).
 */
async function fetchDegrees(
  graph: GraphAdapter,
  ids: readonly string[],
): Promise<Map<string, { inDegree: number; outDegree: number }>> {
  const map = new Map<string, { inDegree: number; outDegree: number }>();
  if (ids.length === 0) return map;
  const rows = await graph.runCypher<CypherDegreeRow>(
    `MATCH (s:Symbol) WHERE s.id IN $ids
     OPTIONAL MATCH (s)<-[inEdge]-(:Symbol)
     OPTIONAL MATCH (s)-[outEdge]->(:Symbol)
     RETURN s.id AS id,
            count(DISTINCT inEdge) AS inDegree,
            count(DISTINCT outEdge) AS outDegree`,
    { ids: [...ids] },
  ) ?? [];
  for (const row of rows) {
    if (!row?.id) continue;
    map.set(row.id, { inDegree: toCount(row.inDegree), outDegree: toCount(row.outDegree) });
  }
  return map;
}

export async function findExternalDependencyByAlias(
  graph: GraphAdapter,
  query: string,
): Promise<GraphNode | null> {
  const rows = await graph.runCypher<CypherExternalDependencyRow>(
    `MATCH (ext:ExternalDependency)
     WHERE toLower(ext.name) CONTAINS toLower($query)
        OR toLower(ext.aliases) CONTAINS toLower($query)
     RETURN ext`,
    { query },
  ) ?? [];
  const nodes = rows
    .filter((row): row is CypherExternalDependencyRow => Boolean(row?.ext?.properties))
    .map((row) => ({
    id: row.ext.properties["id"] ?? "",
    labels: row.ext.labels,
    properties: row.ext.properties,
    }));
  if (nodes.length === 0) return null;
  return nodes.reduce((best, candidate) =>
    prop(best, "name").length <= prop(candidate, "name").length ? best : candidate,
  );
}

async function findDependentsByExternalDependency(
  graph: GraphAdapter,
  externalDependencyId: string,
): Promise<GraphNode[]> {
  const rows = await graph.runCypher<CypherNodeRow>(
    `MATCH (n:Symbol)-[:DEPENDS_ON]->(ext:ExternalDependency)
     WHERE ext.id = $val OR ext.name = $val
     RETURN DISTINCT n`,
    { val: externalDependencyId },
  ) ?? [];
  return rows.map(rowToNode);
}

async function findProcessesBySymbol(graph: GraphAdapter, symbolId: string): Promise<GraphNode[]> {
  const rows = await graph.runCypher<CypherProcessRow>(
    `MATCH (p:Process)-[:HAS_STEP]->(s:Symbol) WHERE s.id = $val OR s.name = $val RETURN DISTINCT p`,
    { val: symbolId },
  ) ?? [];
  return rows
    .filter((row): row is CypherProcessRow => Boolean(row?.p?.properties))
    .map((r) => ({
    id: r.p.properties["id"] ?? "",
    labels: r.p.labels,
    properties: r.p.properties,
    }));
}

async function findClustersBySymbol(graph: GraphAdapter, symbolId: string): Promise<GraphNode[]> {
  const rows = await graph.runCypher<CypherClusterRow>(
    `MATCH (c:Cluster)-[:CONTAINS]->(s:Symbol) WHERE s.id = $val OR s.name = $val RETURN DISTINCT c`,
    { val: symbolId },
  ) ?? [];
  return rows
    .filter((row): row is CypherClusterRow => Boolean(row?.c?.properties))
    .map((r) => ({
    id: r.c.properties["id"] ?? "",
    labels: r.c.labels,
    properties: r.c.properties,
    }));
}

async function findProcessSteps(graph: GraphAdapter, processId: string): Promise<Array<{ order: number; symbolId: string; description: string }>> {
  const rows = await graph.runCypher<CypherStepRow>(
    `MATCH (p:Process {id: $processId})-[r:HAS_STEP]->(s:Symbol)
     RETURN s.id AS symbolId, r.step_order AS stepOrder, s.name AS description
     ORDER BY r.step_order ASC`,
    { processId },
  ) ?? [];
  return rows.map((r) => ({
    order: r.stepOrder,
    symbolId: r.symbolId,
    description: r.description ?? "",
  }));
}

async function graphNodeToProcess(node: GraphNode, graph: GraphAdapter): Promise<Process> {
  const steps = await findProcessSteps(graph, node.id);
  return {
    id: node.id,
    name: prop(node, "name", node.id),
    entryPoint: prop(node, "entryPoint"),
    steps,
    dataFlow: [],
  };
}

/** Return type for executeImpactAnalysis, including resolution info for callers. */
export type ImpactAnalysisResult = {
  resolution: SymbolResolution;
  targetKind: "symbol" | "externalDependency";
  targetName?: string;
  /**
   * D2 — optional per-affected-node explanation (role, entry edge, hop
   * distance, confidence, reasons). Keyed by symbol id, aligned 1:1 with the
   * dependent `symbols` (excluding the target itself). Only populated on the
   * resolved-symbol path; absent for the external-dependency path.
   */
  explanations?: AffectedNodeExplanation[];
} & Pick<QueryResult, "symbols" | "relationships" | "clusters" | "processes" | "confidence" | "riskLevel" | "affectedFlows">;

/**
 * Build per-affected-node explanations (D2). Pure orchestration over the
 * already-fetched direct-caller map + degree aggregate; the role/confidence
 * rules live in {@link explainAffectedNode}.
 */
function buildExplanations(
  dependents: readonly Symbol[],
  directCallers: ReadonlyMap<string, RelationType>,
  degrees: ReadonlyMap<string, { inDegree: number; outDegree: number }>,
): AffectedNodeExplanation[] {
  return dependents.map((dep) => {
    const direct = directCallers.get(dep.id);
    const entryEdge: RelationType = direct ?? "calls";
    // Direct caller → hop 1; otherwise transitive (we know it is reachable but
    // not the exact depth without a per-node BFS) → report hop 2.
    const hopDistance = direct ? 1 : 2;
    const deg = degrees.get(dep.id) ?? { inDegree: 0, outDegree: 0 };
    const degree: NodeDegree = {
      inDegree: deg.inDegree,
      outDegree: deg.outDegree,
      // Wave 8 (T1): prefer the REAL persisted `isExported` signal (Wave 2) over
      // the `visibility === "public"` proxy; fall back to the proxy for
      // pre-Wave-2 graphs where the field is absent.
      isExported: dep.isExported ?? (dep.visibility === "public"),
    };
    return explainAffectedNode({ symbolId: dep.id, entryEdge, hopDistance, degree });
  });
}

/**
 * Execute an impact analysis query using GraphAdapter.runCypher().
 * Uses resolveSymbol for exact → fuzzy fallback (Req 1.1, 1.2, 1.4, 1.5).
 * Requirements: 10.1, 10.2, 10.3, 10.8, 7.2, 1.1, 1.2, 1.4, 1.5
 */
export async function executeImpactAnalysis(
  target: string,
  maxResults: number,
  graphAdapter: GraphAdapter,
  maxDepth?: number,
  // Wave 8 (T7): optional confidence floor. The transitive-dependent traversal
  // runs over CALLS edges, which carry NO `metadata.confidence` today, so this
  // filter is a documented no-op on the CALLS path (kept forward-compatible for
  // when call edges gain confidence). It DOES apply to any dependent whose edge
  // metadata carries a `confidence` below the floor. Absent → unchanged.
  minConfidence?: number,
): Promise<ImpactAnalysisResult> {
  const exactRows = await graphAdapter.runCypher<CypherNodeRow>(
    `MATCH (n:Symbol) WHERE n.id = $val OR n.name = $val RETURN n LIMIT 1`,
    { val: target },
  ) ?? [];
  const exactSymbolNode = exactRows[0]?.n?.properties ? rowToNode(exactRows[0]) : null;

  const matchedExternalDependency = exactSymbolNode === null
    ? await findExternalDependencyByAlias(graphAdapter, target)
    : null;
  if (matchedExternalDependency) {
    const dependentNodes = await findDependentsByExternalDependency(graphAdapter, matchedExternalDependency.id);
    const dependentSymbols = dependentNodes.map(graphNodeToSymbol);
    const processes = await Promise.all(
      (await Promise.all(
        dependentSymbols.map((symbol) => findProcessesBySymbol(graphAdapter, symbol.id)),
      )).flat().map((node) => graphNodeToProcess(node, graphAdapter)),
    );
    const relationships: Relationship[] = dependentSymbols.map((dep) => ({
      id: `${dep.id}->dependsOn->${matchedExternalDependency.id}`,
      source: dep.id,
      target: matchedExternalDependency.id,
      relType: "dependsOn",
      metadata: {
        packageName: prop(matchedExternalDependency, "name", matchedExternalDependency.id),
      },
    }));

    return {
      resolution: { kind: "exact", node: matchedExternalDependency },
      targetKind: "externalDependency",
      targetName: prop(matchedExternalDependency, "name", matchedExternalDependency.id),
      symbols: dependentSymbols.slice(0, maxResults),
      relationships,
      clusters: [],
      processes,
      confidence: dependentSymbols.length > 0 ? 0.92 : 0.75,
      riskLevel: calculateImpactRisk(dependentSymbols),
      affectedFlows: processes.map((process) => process.name),
    };
  }

  const resolution = exactSymbolNode !== null
    ? { kind: "exact" as const, node: exactSymbolNode }
    : await resolveSymbol(target, graphAdapter);

  if (resolution.kind === "not_found") {
    return {
      resolution,
      targetKind: "symbol",
      symbols: [],
      relationships: [],
      clusters: [],
      processes: [],
      confidence: 0.5,
      riskLevel: "low" as const,
      affectedFlows: [],
    };
  }

  // Both "exact" and "fuzzy" provide a resolved node
  const targetNode = resolution.node;
  const targetSymbol = graphNodeToSymbol(targetNode);

  // Req 10.2 — find all direct and transitive dependents (depth-bounded; D3 fix
  // for the previously-dead find_dependents.maxDepth).
  const dependentNodes = await findDependents(graphAdapter, target, clampTraversalDepth(maxDepth));
  // Wave 8 (T7): optional confidence floor. CALLS edges carry NO confidence
  // today, so this prunes only nodes that DO carry a `confidence` prop below the
  // floor (forward-compatible); the CALLS path is unaffected. Absent → unchanged.
  const hasFloor = typeof minConfidence === "number" && Number.isFinite(minConfidence);
  const keptDependentNodes = hasFloor
    ? dependentNodes.filter((n) => {
        const raw = prop(n, "confidence");
        if (raw === "") return true; // no edge confidence → keep (CALLS path)
        const c = Number(raw);
        return !Number.isFinite(c) || c >= (minConfidence as number);
      })
    : dependentNodes;
  const dependentSymbols = keptDependentNodes.map(graphNodeToSymbol);

  // Req 10.3 — identify affected business processes
  const processNodes = await findProcessesBySymbol(graphAdapter, target);
  const processes = await Promise.all(processNodes.map((n) => graphNodeToProcess(n, graphAdapter)));

  // Collect clusters for context
  const clusterNodes = await findClustersBySymbol(graphAdapter, target);
  const clusters = clusterNodes.map(graphNodeToCluster);

  // Build relationships: target ← each dependent
  const relationships: Relationship[] = dependentSymbols.map((dep) => ({
    id: `${dep.id}->calls->${target}`,
    source: dep.id,
    target,
    relType: "calls" as const,
    metadata: {},
  }));

  const allSymbols = [targetSymbol, ...dependentSymbols].slice(0, maxResults);
  const riskLevel = calculateImpactRisk(dependentSymbols);
  const affectedFlows = processes.map((p) => p.name);

  // Confidence: high when target resolved + dependents found
  const confidence = dependentSymbols.length > 0 ? 0.92 : 0.75;

  // ── D2 explainability ──────────────────────────────────────────────────────
  // Issued AFTER the existing query sequence so the external-dependency path's
  // call ordering is unaffected. Only explain the dependents actually returned
  // (post-slice, excluding the target at index 0).
  const explainedDependents = allSymbols.slice(1);
  const directCallers = await findDirectCallers(graphAdapter, target);
  const degrees = await fetchDegrees(graphAdapter, explainedDependents.map((s) => s.id));
  const explanations = buildExplanations(explainedDependents, directCallers, degrees);

  return {
    resolution,
    targetKind: "symbol",
    symbols: allSymbols,
    relationships,
    clusters,
    processes,
    confidence,
    riskLevel,
    affectedFlows,
    explanations,
  };
}
