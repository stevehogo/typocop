/**
 * GraphReader — fetches all graph data via GraphAdapter.
 * Requirements: 2.1–2.9
 */
import type { GraphAdapter, GraphNode } from "../../core/ports/persistence.js";
import { getExportGraphReadPageSize } from "../../platform/utils/limits.js";

export interface ExportedSymbol {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly visibility: string;
  readonly signature: string;
  readonly documentation: string;
}

export interface ExportedCluster {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly confidence: number;
  readonly symbolCount: number;
}

export interface ExportedProcess {
  readonly id: string;
  readonly name: string;
  readonly entryPoint: string;
  readonly stepCount: number;
}

export interface ExportedExternalDependency {
  readonly id: string;
  readonly name: string;
  readonly aliases: string;
  readonly ecosystem: string;
}

export interface ExportedRelationship {
  readonly sourceId: string;
  readonly targetId: string;
  readonly relType: string;
  readonly sourceName: string;
  readonly targetName: string;
}

export interface ExportedProcessStep {
  readonly order: number;
  readonly symbolId: string;
  readonly symbolName: string;
}

export interface GraphData {
  readonly symbols: ExportedSymbol[];
  readonly clusters: ExportedCluster[];
  readonly processes: ExportedProcess[];
  readonly externalDependencies: ExportedExternalDependency[];
  readonly relationships: ExportedRelationship[];
  readonly dependsOnEdges: ExportedRelationship[];
  readonly clusterMemberships: ReadonlyMap<string, string[]>;
  readonly processSteps: ReadonlyMap<string, ExportedProcessStep[]>;
}

const EMPTY_GRAPH_DATA: GraphData = {
  symbols: [],
  clusters: [],
  processes: [],
  externalDependencies: [],
  relationships: [],
  dependsOnEdges: [],
  clusterMemberships: new Map(),
  processSteps: new Map(),
};

const RELATIONSHIP_TYPES = ["CALLS", "IMPORTS", "INHERITS", "IMPLEMENTS"] as const;
const RESOURCE_EXHAUSTED_GRPC_CODE = 8;

export interface FetchAllGraphDataOptions {
  readonly pageSize?: number;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "toNumber" in value) {
    return (value as { toNumber(): number }).toNumber();
  }
  return 0;
}

/**
 * Fetch all graph data via GraphAdapter.
 * Requirements: 2.1–2.8
 */
export async function fetchAllGraphData(
  graphAdapter: GraphAdapter,
  prefix: string,
  options: FetchAllGraphDataOptions = {},
): Promise<GraphData> {
  const pageSize = options.pageSize ?? getExportGraphReadPageSize();

  // 2.1 Fetch all Symbol nodes
  const symbolRows = await fetchPagedRows<Record<string, unknown>>(
    graphAdapter,
    `MATCH (s:\`${prefix}Symbol\`) RETURN s.id AS id, s.name AS name, s.kind AS kind, s.filePath AS filePath, s.startLine AS startLine, s.endLine AS endLine, s.visibility AS visibility, s.signature AS signature, s.documentation AS documentation ORDER BY s.id`,
    pageSize,
  );

  const symbols: ExportedSymbol[] = symbolRows.map((row) => ({
    id: (row.id as string) ?? "",
    name: (row.name as string) ?? "",
    kind: (row.kind as string) ?? "",
    filePath: (row.filePath as string) ?? "",
    startLine: toNumber(row.startLine),
    endLine: toNumber(row.endLine),
    visibility: (row.visibility as string) ?? "public",
    signature: (row.signature as string) ?? "",
    documentation: (row.documentation as string) ?? "",
  }));

  // 2.9 Handle empty graph
  if (symbols.length === 0) {
    return EMPTY_GRAPH_DATA;
  }

  // 2.2 Fetch all Cluster nodes
  const clusterRows = await fetchPagedRows<Record<string, unknown>>(
    graphAdapter,
    `MATCH (c:\`${prefix}Cluster\`) RETURN c.id AS id, c.name AS name, c.category AS category, c.confidence AS confidence, c.symbolCount AS symbolCount ORDER BY c.id`,
    pageSize,
  );

  const clusters: ExportedCluster[] = clusterRows.map((row) => ({
    id: (row.id as string) ?? "",
    name: (row.name as string) ?? "",
    category: (row.category as string) ?? "unknown",
    confidence: typeof row.confidence === "number" ? row.confidence : 0,
    symbolCount: toNumber(row.symbolCount),
  }));

  // 2.3 Fetch all Process nodes
  const processRows = await fetchPagedRows<Record<string, unknown>>(
    graphAdapter,
    `MATCH (p:\`${prefix}Process\`) RETURN p.id AS id, p.name AS name, p.entryPoint AS entryPoint, p.stepCount AS stepCount ORDER BY p.id`,
    pageSize,
  );

  const processes: ExportedProcess[] = processRows.map((row) => ({
    id: (row.id as string) ?? "",
    name: (row.name as string) ?? "",
    entryPoint: (row.entryPoint as string) ?? "",
    stepCount: toNumber(row.stepCount),
  }));

  const externalDependencyRows = await fetchPagedRows<Record<string, unknown>>(
    graphAdapter,
    `MATCH (ext:\`${prefix}ExternalDependency\`)
     RETURN ext.id AS id, ext.name AS name, ext.aliases AS aliases, ext.ecosystem AS ecosystem
     ORDER BY ext.id`,
    pageSize,
  );

  const externalDependencies: ExportedExternalDependency[] = externalDependencyRows.map((row) => ({
    id: (row.id as string) ?? "",
    name: (row.name as string) ?? "",
    aliases: (row.aliases as string) ?? "",
    ecosystem: (row.ecosystem as string) ?? "unknown",
  }));

  // 2.4 Fetch relationships with name resolution
  const relationships: ExportedRelationship[] = [];
  for (const relType of RELATIONSHIP_TYPES) {
    const relRows = await fetchPagedRows<Record<string, unknown>>(
      graphAdapter,
      `MATCH (src:\`${prefix}Symbol\`)-[r:\`${prefix}${relType}\`]->(tgt:\`${prefix}Symbol\`)
       RETURN src.id AS sourceId, src.name AS sourceName,
              tgt.id AS targetId, tgt.name AS targetName
       ORDER BY src.id, tgt.id`,
      pageSize,
    );
    for (const row of relRows) {
      relationships.push({
        sourceId: (row.sourceId as string) ?? "",
        targetId: (row.targetId as string) ?? "",
        relType,
        sourceName: (row.sourceName as string) ?? "",
        targetName: (row.targetName as string) ?? "",
      });
    }
  }

  const dependsOnRows = await fetchPagedRows<Record<string, unknown>>(
    graphAdapter,
    `MATCH (src:\`${prefix}Symbol\`)-[:\`${prefix}DEPENDS_ON\`]->(ext:\`${prefix}ExternalDependency\`)
     RETURN src.id AS sourceId, src.name AS sourceName, ext.id AS targetId, ext.name AS targetName
     ORDER BY src.id, ext.id`,
    pageSize,
  );

  const dependsOnEdges: ExportedRelationship[] = dependsOnRows.map((row) => ({
    sourceId: (row.sourceId as string) ?? "",
    targetId: (row.targetId as string) ?? "",
    relType: "DEPENDS_ON",
    sourceName: (row.sourceName as string) ?? "",
    targetName: (row.targetName as string) ?? "",
  }));

  // 2.5 Fetch cluster memberships (CONTAINS)
  const membershipRows = await fetchPagedRows<Record<string, unknown>>(
    graphAdapter,
    `MATCH (c:\`${prefix}Cluster\`)-[:\`${prefix}CONTAINS\`]->(s:\`${prefix}Symbol\`)
     RETURN c.id AS clusterId, s.id AS symbolId
     ORDER BY c.id, s.id`,
    pageSize,
  );

  const clusterMemberships = new Map<string, string[]>();
  for (const row of membershipRows) {
    const clusterId = (row.clusterId as string) ?? "";
    const symbolId = (row.symbolId as string) ?? "";
    const members = clusterMemberships.get(clusterId);
    if (members) {
      members.push(symbolId);
    } else {
      clusterMemberships.set(clusterId, [symbolId]);
    }
  }

  // 2.6 Fetch process steps (HAS_STEP) with order property
  const stepsRows = await fetchPagedRows<Record<string, unknown>>(
    graphAdapter,
    `MATCH (p:\`${prefix}Process\`)-[r:\`${prefix}HAS_STEP\`]->(s:\`${prefix}Symbol\`)
     RETURN p.id AS processId, s.id AS symbolId, s.name AS symbolName, r.step_order AS stepOrder
     ORDER BY p.id, r.step_order, s.id`,
    pageSize,
  );

  const processSteps = new Map<string, ExportedProcessStep[]>();
  for (const row of stepsRows) {
    const processId = (row.processId as string) ?? "";
    const step: ExportedProcessStep = {
      order: toNumber(row.stepOrder),
      symbolId: (row.symbolId as string) ?? "",
      symbolName: (row.symbolName as string) ?? "",
    };
    const steps = processSteps.get(processId);
    if (steps) {
      steps.push(step);
    } else {
      processSteps.set(processId, [step]);
    }
  }

  return {
    symbols,
    clusters,
    processes,
    externalDependencies,
    relationships,
    dependsOnEdges,
    clusterMemberships,
    processSteps,
  };
}

async function fetchPagedRows<T>(
  graphAdapter: GraphAdapter,
  orderedQuery: string,
  initialPageSize: number,
): Promise<T[]> {
  if (!Number.isInteger(initialPageSize) || initialPageSize <= 0) {
    throw new Error(`pageSize must be a positive integer, got ${initialPageSize}`);
  }

  const rows: T[] = [];
  let skip = 0;
  let pageSize = initialPageSize;

  while (true) {
    try {
      const page = await graphAdapter.runCypher<T>(
        `${orderedQuery}\nSKIP ${skip} LIMIT ${pageSize}`,
      );
      rows.push(...page);
      if (page.length < pageSize) {
        return rows;
      }
      skip += page.length;
    } catch (error) {
      if (!isResourceExhaustedError(error) || pageSize === 1) {
        throw error;
      }
      pageSize = Math.max(1, Math.floor(pageSize / 2));
    }
  }
}

function isResourceExhaustedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (error as { readonly code?: unknown }).code === RESOURCE_EXHAUSTED_GRPC_CODE;
}
