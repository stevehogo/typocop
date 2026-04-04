/**
 * Data flow tracing query logic.
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7
 */
import type { Session } from "neo4j-driver";
import type { Symbol, Relationship, Cluster, Process, QueryResult, SymbolKind, Visibility, ClusterCategory } from "../types/index.js";
import { findNode, findDependencies } from "../graph/query.js";
import type { GraphNode } from "../graph/connection.js";

/** Layer classification patterns */
const LAYER_PATTERNS = {
  api: [/endpoint/i, /route/i, /controller.*action/i, /api/i, /@get/i, /@post/i, /@put/i, /@delete/i],
  controller: [/controller/i, /handler/i],
  service: [/service/i, /manager/i, /business/i],
  repository: [/repository/i, /dao/i, /store/i],
  model: [/model/i, /entity/i, /schema/i, /table/i],
};

function classifyLayer(node: GraphNode): "api" | "controller" | "service" | "repository" | "model" | "unknown" {
  const name = node.properties["name"]?.toLowerCase() ?? "";
  const filePath = node.properties["filePath"]?.toLowerCase() ?? "";
  const signature = node.properties["signature"]?.toLowerCase() ?? "";
  const combined = `${name} ${filePath} ${signature}`;

  for (const [layer, patterns] of Object.entries(LAYER_PATTERNS)) {
    if (patterns.some((p) => p.test(combined))) {
      return layer as "api" | "controller" | "service" | "repository" | "model";
    }
  }
  return "unknown";
}

function graphNodeToSymbol(node: GraphNode): Symbol {
  const p = node.properties;
  return {
    id: node.id,
    name: p["name"] ?? node.id,
    kind: (p["kind"] ?? "function") as SymbolKind,
    location: {
      filePath: p["filePath"] ?? "",
      startLine: parseInt(p["startLine"] ?? "0", 10),
      startColumn: parseInt(p["startColumn"] ?? "0", 10),
      endLine: parseInt(p["endLine"] ?? "0", 10),
      endColumn: parseInt(p["endColumn"] ?? "0", 10),
    },
    signature: p["signature"],
    visibility: (p["visibility"] ?? "public") as Visibility,
    modifiers: [],
  };
}

/**
 * Execute a data flow tracing query.
 * Traces from API endpoint through controllers, services, repositories to database models.
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7
 */
export async function executeDataFlowTrace(
  entryPoint: string,
  maxResults: number,
  graphSession: Session,
): Promise<Pick<QueryResult, "symbols" | "relationships" | "clusters" | "processes" | "confidence" | "riskLevel" | "affectedFlows">> {
  // Req 13.1 — identify entry point symbol
  const entryNode = await findNode(graphSession, entryPoint);
  if (!entryNode) {
    return {
      symbols: [],
      relationships: [],
      clusters: [],
      processes: [],
      confidence: 0.5,
      riskLevel: "low",
      affectedFlows: [],
    };
  }

  const entrySymbol = graphNodeToSymbol(entryNode);

  // Req 13.2-13.5 — trace through all dependencies
  const dependencyNodes = await findDependencies(graphSession, entryPoint);
  
  // Classify nodes by layer
  const layeredNodes = new Map<string, GraphNode[]>();
  layeredNodes.set("api", [entryNode]);
  
  for (const node of dependencyNodes) {
    const layer = classifyLayer(node);
    if (!layeredNodes.has(layer)) {
      layeredNodes.set(layer, []);
    }
    layeredNodes.get(layer)!.push(node);
  }

  // Build ordered path: API → Controller → Service → Repository → Model
  const orderedLayers = ["api", "controller", "service", "repository", "model"];
  const pathSymbols: Symbol[] = [];
  const relationships: Relationship[] = [];

  for (const layer of orderedLayers) {
    const nodes = layeredNodes.get(layer) ?? [];
    pathSymbols.push(...nodes.map(graphNodeToSymbol));
  }

  // Build relationships between consecutive symbols
  for (let i = 0; i < pathSymbols.length - 1; i++) {
    relationships.push({
      id: `${pathSymbols[i].id}->calls->${pathSymbols[i + 1].id}`,
      source: pathSymbols[i].id,
      target: pathSymbols[i + 1].id,
      relType: "calls",
      metadata: {},
    });
  }

  // Req 13.6 — return complete path
  const allSymbols = pathSymbols.slice(0, maxResults);
  
  // Req 13.7 — check for Full tracing (API + Controller + DB)
  const hasApi = layeredNodes.has("api") && layeredNodes.get("api")!.length > 0;
  const hasController = layeredNodes.has("controller") && layeredNodes.get("controller")!.length > 0;
  const hasModel = layeredNodes.has("model") && layeredNodes.get("model")!.length > 0;
  const isFullTrace = hasApi && hasController && hasModel;

  const confidence = isFullTrace ? 0.92 : (pathSymbols.length > 1 ? 0.75 : 0.60);

  return {
    symbols: allSymbols,
    relationships,
    clusters: [],
    processes: [],
    confidence,
    riskLevel: "low", // Data flow tracing is informational
    affectedFlows: orderedLayers.filter((l) => layeredNodes.has(l) && layeredNodes.get(l)!.length > 0),
  };
}
