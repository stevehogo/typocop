/**
 * GraphReader — fetches all graph data from Neo4j in a single read transaction.
 * Requirements: 2.1–2.9
 */
import type { Session } from "neo4j-driver";

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
  readonly relationships: ExportedRelationship[];
  readonly clusterMemberships: ReadonlyMap<string, string[]>;
  readonly processSteps: ReadonlyMap<string, ExportedProcessStep[]>;
}

const EMPTY_GRAPH_DATA: GraphData = {
  symbols: [],
  clusters: [],
  processes: [],
  relationships: [],
  clusterMemberships: new Map(),
  processSteps: new Map(),
};

const RELATIONSHIP_TYPES = ["CALLS", "IMPORTS", "INHERITS", "IMPLEMENTS"] as const;

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "toNumber" in value) {
    return (value as { toNumber(): number }).toNumber();
  }
  return 0;
}

/**
 * Fetch all graph data from Neo4j in a single read transaction.
 * Requirements: 2.1–2.8
 */
export async function fetchAllGraphData(session: Session, prefix: string): Promise<GraphData> {
  return session.executeRead(async (tx) => {
    // 2.1 Fetch all Symbol nodes
    const symbolResult = await tx.run(
      `MATCH (s:\`${prefix}Symbol\`) RETURN s`,
    );

    const symbols: ExportedSymbol[] = symbolResult.records.map((record) => {
      const node = record.get("s");
      const props = node.properties;
      return {
        id: props.id ?? "",
        name: props.name ?? "",
        kind: props.kind ?? "",
        filePath: props.filePath ?? "",
        startLine: toNumber(props.startLine),
        endLine: toNumber(props.endLine),
        visibility: props.visibility ?? "public",
        signature: props.signature ?? "",
        documentation: props.documentation ?? "",
      };
    });

    // 2.9 Handle empty graph
    if (symbols.length === 0) {
      return EMPTY_GRAPH_DATA;
    }

    // 2.2 Fetch all Cluster nodes
    const clusterResult = await tx.run(
      `MATCH (c:\`${prefix}Cluster\`) RETURN c`,
    );

    const clusters: ExportedCluster[] = clusterResult.records.map((record) => {
      const node = record.get("c");
      const props = node.properties;
      return {
        id: props.id ?? "",
        name: props.name ?? "",
        category: props.category ?? "unknown",
        confidence: typeof props.confidence === "number" ? props.confidence : 0,
        symbolCount: toNumber(props.symbolCount),
      };
    });

    // 2.3 Fetch all Process nodes
    const processResult = await tx.run(
      `MATCH (p:\`${prefix}Process\`) RETURN p`,
    );

    const processes: ExportedProcess[] = processResult.records.map((record) => {
      const node = record.get("p");
      const props = node.properties;
      return {
        id: props.id ?? "",
        name: props.name ?? "",
        entryPoint: props.entryPoint ?? "",
        stepCount: toNumber(props.stepCount),
      };
    });

    // 2.4 Fetch relationships with name resolution
    const relationships: ExportedRelationship[] = [];
    for (const relType of RELATIONSHIP_TYPES) {
      const relResult = await tx.run(
        `MATCH (src:\`${prefix}Symbol\`)-[r:\`${prefix}${relType}\`]->(tgt:\`${prefix}Symbol\`)
         RETURN src.id AS sourceId, src.name AS sourceName,
                tgt.id AS targetId, tgt.name AS targetName`,
      );
      for (const record of relResult.records) {
        relationships.push({
          sourceId: record.get("sourceId") ?? "",
          targetId: record.get("targetId") ?? "",
          relType,
          sourceName: record.get("sourceName") ?? "",
          targetName: record.get("targetName") ?? "",
        });
      }
    }

    // 2.5 Fetch cluster memberships (CONTAINS)
    const membershipResult = await tx.run(
      `MATCH (c:\`${prefix}Cluster\`)-[:\`${prefix}CONTAINS\`]->(s:\`${prefix}Symbol\`)
       RETURN c.id AS clusterId, s.id AS symbolId`,
    );

    const clusterMemberships = new Map<string, string[]>();
    for (const record of membershipResult.records) {
      const clusterId: string = record.get("clusterId") ?? "";
      const symbolId: string = record.get("symbolId") ?? "";
      const members = clusterMemberships.get(clusterId);
      if (members) {
        members.push(symbolId);
      } else {
        clusterMemberships.set(clusterId, [symbolId]);
      }
    }

    // 2.6 Fetch process steps (HAS_STEP) with order property
    const stepsResult = await tx.run(
      `MATCH (p:\`${prefix}Process\`)-[r:\`${prefix}HAS_STEP\`]->(s:\`${prefix}Symbol\`)
       RETURN p.id AS processId, s.id AS symbolId, s.name AS symbolName, r.order AS stepOrder
       ORDER BY p.id, r.order`,
    );

    const processSteps = new Map<string, ExportedProcessStep[]>();
    for (const record of stepsResult.records) {
      const processId: string = record.get("processId") ?? "";
      const step: ExportedProcessStep = {
        order: toNumber(record.get("stepOrder")),
        symbolId: record.get("symbolId") ?? "",
        symbolName: record.get("symbolName") ?? "",
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
      relationships,
      clusterMemberships,
      processSteps,
    };
  });
}
