/**
 * Class-based Graph Store with node label prefix support.
 * Requirements: 4.1–4.6, 6.1–6.4
 */
import type { Session } from "neo4j-driver";
import type { GraphNode } from "./connection.js";

/**
 * GraphStore wraps Neo4j session operations and prepends a configurable
 * prefix to all node labels and relationship types.
 *
 * Requirements: 4.1, 6.1–6.4
 */
export class GraphStore {
  private readonly prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
    console.debug(`[graph-store] Initialized with prefix: "${prefix}"`);
  }

  /**
   * Return the prefixed node label.
   * Empty prefix → base label unchanged.
   * Requirements: 4.1, 4.3
   */
  getLabel(baseLabel: string): string {
    return `${this.prefix}${baseLabel}`;
  }

  /**
   * Return the prefixed relationship type.
   * Empty prefix → base type unchanged.
   * Requirements: 5.1, 5.3
   */
  getRelationType(baseType: string): string {
    return `${this.prefix}${baseType}`;
  }

  /**
   * Create or update a node using MERGE on id, then SET all properties.
   * Requirements: 4.4
   */
  async createNode(
    session: Session,
    label: string,
    properties: Record<string, unknown>,
  ): Promise<void> {
    const prefixedLabel = this.getLabel(label);
    const { id, ...rest } = properties as { id: string } & Record<string, unknown>;
    await session.executeWrite((tx) =>
      tx.run(
        `MERGE (n:${prefixedLabel} {id: $id}) SET n += $props`,
        { id, props: { ...rest, id } },
      ),
    );
  }

  /**
   * Create or update a relationship between two nodes by id.
   * Requirements: 5.4
   */
  async createRelationship(
    session: Session,
    fromId: string,
    toId: string,
    type: string,
    properties: Record<string, unknown> = {},
  ): Promise<void> {
    const prefixedType = this.getRelationType(type);
    await session.executeWrite((tx) =>
      tx.run(
        `MATCH (a {id: $fromId}), (b {id: $toId})
         MERGE (a)-[r:${prefixedType}]->(b)
         SET r += $props`,
        { fromId, toId, props: properties },
      ),
    );
  }

  /**
   * Query nodes by prefixed label with optional property filter.
   * Requirements: 4.5
   */
  async queryNodes(
    session: Session,
    label: string,
    filter: Record<string, unknown> = {},
  ): Promise<GraphNode[]> {
    const prefixedLabel = this.getLabel(label);
    const hasFilter = Object.keys(filter).length > 0;
    const whereClause = hasFilter
      ? "WHERE " + Object.keys(filter).map((k) => `n.${k} = $filter.${k}`).join(" AND ")
      : "";

    const result = await session.executeRead((tx) =>
      tx.run(
        `MATCH (n:${prefixedLabel}) ${whereClause} RETURN n`,
        { filter },
      ),
    );

    return result.records.map((record) => {
      const n = record.get("n") as { labels: string[]; properties: Record<string, string> };
      return {
        id: n.properties["id"] ?? "",
        labels: n.labels,
        properties: n.properties,
      };
    });
  }

  /**
   * Query all relationships of the given prefixed type.
   * Requirements: 5.2, 5.5
   */
  async queryRelationships(
    session: Session,
    type: string,
  ): Promise<{ type: string; properties: Record<string, unknown> }[]> {
    const prefixedType = this.getRelationType(type);
    const result = await session.executeRead((tx) =>
      tx.run(`MATCH ()-[r:${prefixedType}]->() RETURN r`),
    );
    return result.records.map((record) => {
      const r = record.get("r") as { type: string; properties: Record<string, unknown> };
      return { type: r.type, properties: r.properties };
    });
  }

  /**
   * Delete all relationships of the given prefixed type.
   * Requirements: 5.6
   */
  async deleteRelationshipsByType(session: Session, type: string): Promise<void> {
    const prefixedType = this.getRelationType(type);
    await session.executeWrite((tx) =>
      tx.run(`MATCH ()-[r:${prefixedType}]->() DELETE r`),
    );
  }

  /**
   * Delete all nodes (and their relationships) with the given prefixed label.
   * Requirements: 4.6
   */
  async deleteNodesByLabel(session: Session, label: string): Promise<void> {
    const prefixedLabel = this.getLabel(label);
    await session.executeWrite((tx) =>
      tx.run(`MATCH (n:${prefixedLabel}) DETACH DELETE n`),
    );
  }
}
