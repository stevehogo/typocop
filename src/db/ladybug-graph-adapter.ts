/**
 * LadybugGraphAdapter — GraphAdapter implementation backed by LadybugDB's
 * Cypher-compatible Connection.query() API with prefix-aware label/type management.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */

import type { Connection, LbugValue, NodeValue, RelValue } from "@ladybugdb/core";
import type { GraphAdapter, GraphNode, GraphRelationship } from "./types.js";

/**
 * Implements `GraphAdapter` using LadybugDB's Connection.query() API.
 * All node labels and relationship types are automatically prefixed with
 * `TYPOCOP_PREFIX` to ensure per-project isolation within a shared database.
 */
export class LadybugGraphAdapter implements GraphAdapter {
  private schemaInitialized = false;

  constructor(
    private readonly connection: Connection,
    private readonly prefix: string,
  ) {}

  private prefixLabel(label: string): string {
    return `${this.prefix}${label}`;
  }

  private prefixType(type: string): string {
    return `${this.prefix}${type}`;
  }

  /** Execute a Cypher query and return all result rows. */
  private async exec(query: string): Promise<Record<string, LbugValue>[]> {
    const result = await this.connection.query(query);
    if (Array.isArray(result)) {
      return result[0] ? await result[0].getAll() : [];
    }
    return result.getAll();
  }

  /** Execute a parameterized Cypher query using prepare + execute. */
  private async execWithParams(
    query: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, LbugValue>[]> {
    const ps = await this.connection.prepare(query);
    if (!ps.isSuccess()) {
      throw new Error(`Query preparation failed: ${ps.getErrorMessage()}`);
    }
    const result = await this.connection.execute(ps, params as Record<string, LbugValue>);
    if (Array.isArray(result)) {
      return result[0] ? await result[0].getAll() : [];
    }
    return result.getAll();
  }

  /**
   * Create all required node and relationship tables.
   * LadybugDB (Kùzu) requires explicit schema before data insertion.
   * Safe to call multiple times — uses IF NOT EXISTS.
   */
  async initializeSchema(): Promise<void> {
    if (this.schemaInitialized) return;

    const nodeLabels = ["Symbol", "Cluster", "Process", "Metadata"];
    for (const label of nodeLabels) {
      const tbl = this.prefixLabel(label);
      await this.exec(
        `CREATE NODE TABLE IF NOT EXISTS ${tbl} (id STRING, name STRING, kind STRING, filePath STRING, startLine STRING, startColumn STRING, endLine STRING, endColumn STRING, visibility STRING, signature STRING, documentation STRING, category STRING, confidence STRING, symbolCount STRING, entryPoint STRING, stepCount STRING, key STRING, timestamp STRING, PRIMARY KEY(id))`,
      );
    }

    // Rel tables: each connects exactly one FROM table to one TO table (Kùzu requirement)
    const sym = this.prefixLabel("Symbol");
    const cls = this.prefixLabel("Cluster");
    const proc = this.prefixLabel("Process");

    // Symbol → Symbol relationships
    const symToSym = ["CALLS", "IMPORTS", "INHERITS", "IMPLEMENTS", "REFERENCES", "DEFINES"];
    for (const relType of symToSym) {
      const tbl = this.prefixType(relType);
      await this.exec(`CREATE REL TABLE IF NOT EXISTS ${tbl} (FROM ${sym} TO ${sym})`);
    }

    // Cluster → Symbol (CONTAINS)
    const containsTbl = this.prefixType("CONTAINS");
    await this.exec(`CREATE REL TABLE IF NOT EXISTS ${containsTbl} (FROM ${cls} TO ${sym})`);

    // Process → Symbol (HAS_STEP) — step_order tracks ordering
    const hasStepTbl = this.prefixType("HAS_STEP");
    await this.exec(`CREATE REL TABLE IF NOT EXISTS ${hasStepTbl} (FROM ${proc} TO ${sym}, step_order STRING)`);

    this.schemaInitialized = true;
  }

  async createNode(
    label: string,
    properties: Record<string, unknown>,
  ): Promise<void> {
    const prefixedLabel = this.prefixLabel(label);
    const { id, ...rest } = properties as { id: string } & Record<string, unknown>;
    const setEntries = Object.entries(rest);
    const setClause = setEntries.length > 0
      ? " ON MATCH SET " + setEntries.map(([k, v]) => `n.${k} = ${JSON.stringify(v)}`).join(", ") +
        " ON CREATE SET " + setEntries.map(([k, v]) => `n.${k} = ${JSON.stringify(v)}`).join(", ")
      : "";
    await this.exec(
      `MERGE (n:${prefixedLabel} {id: "${id}"})${setClause}`,
    );
  }

  /** Known rel table properties declared in schema. */
  private static readonly REL_SCHEMA_PROPS: Record<string, Set<string>> = {
    HAS_STEP: new Set(["step_order"]),
  };

  /** Map relationship type to source/target node labels (Kùzu requires labels). */
  private static readonly REL_LABEL_MAP: Record<string, [string, string]> = {
    CALLS: ["Symbol", "Symbol"],
    IMPORTS: ["Symbol", "Symbol"],
    INHERITS: ["Symbol", "Symbol"],
    IMPLEMENTS: ["Symbol", "Symbol"],
    REFERENCES: ["Symbol", "Symbol"],
    DEFINES: ["Symbol", "Symbol"],
    CONTAINS: ["Cluster", "Symbol"],
    HAS_STEP: ["Process", "Symbol"],
  };

  async createRelationship(
    fromId: string,
    toId: string,
    type: string,
    properties: Record<string, unknown> = {},
  ): Promise<void> {
    const prefixedType = this.prefixType(type);
    const labels = LadybugGraphAdapter.REL_LABEL_MAP[type] ?? ["Symbol", "Symbol"];
    const fromLabel = this.prefixLabel(labels[0]);
    const toLabel = this.prefixLabel(labels[1]);
    // Only set properties that exist in the rel table schema (Kùzu is strict)
    const allowed = LadybugGraphAdapter.REL_SCHEMA_PROPS[type] ?? new Set<string>();
    const propEntries = Object.entries(properties).filter(([k]) => allowed.has(k));
    const setClause = propEntries.length > 0
      ? " ON MATCH SET " + propEntries.map(([k, v]) => `r.${k} = ${JSON.stringify(v)}`).join(", ") +
        " ON CREATE SET " + propEntries.map(([k, v]) => `r.${k} = ${JSON.stringify(v)}`).join(", ")
      : "";
    await this.exec(
      `MATCH (a:${fromLabel} {id: "${fromId}"}), (b:${toLabel} {id: "${toId}"}) MERGE (a)-[r:${prefixedType}]->(b)${setClause}`,
    );
  }

  async queryNodes(
    label: string,
    filter: Record<string, unknown> = {},
  ): Promise<GraphNode[]> {
    const prefixedLabel = this.prefixLabel(label);
    const filterKeys = Object.keys(filter);
    const whereClause = filterKeys.length > 0
      ? "WHERE " + filterKeys.map((k) => `n.${k} = "${String(filter[k])}"`).join(" AND ")
      : "";

    const rows = await this.exec(
      `MATCH (n:${prefixedLabel}) ${whereClause} RETURN n`,
    );

    return rows.map((row) => {
      const n = row["n"] as NodeValue;
      return {
        id: (n["id"] as string) ?? "",
        labels: n._label ? [n._label] : [],
        properties: { ...n } as Record<string, unknown>,
      };
    });
  }

  async queryRelationships(type: string): Promise<GraphRelationship[]> {
    const prefixedType = this.prefixType(type);
    const rows = await this.exec(
      `MATCH ()-[r:${prefixedType}]->() RETURN r`,
    );

    return rows.map((row) => {
      const r = row["r"] as RelValue;
      return {
        type: r._label ?? prefixedType,
        properties: { ...r } as Record<string, unknown>,
      };
    });
  }

  async deleteNodesByLabel(label: string): Promise<number> {
    const prefixedLabel = this.prefixLabel(label);
    const countRows = await this.exec(`MATCH (n:${prefixedLabel}) RETURN count(n) as count`);
    const count = countRows[0]?.count as number ?? 0;
    await this.exec(`MATCH (n:${prefixedLabel}) DETACH DELETE n`);
    return count;
  }

  async deleteRelationshipsByType(type: string): Promise<number> {
    const prefixedType = this.prefixType(type);
    const countRows = await this.exec(`MATCH ()-[r:${prefixedType}]->() RETURN count(r) as count`);
    const count = countRows[0]?.count as number ?? 0;
    await this.exec(`MATCH ()-[r:${prefixedType}]->() DELETE r`);
    return count;
  }

  /**
   * Normalize a Kùzu NodeValue into the { labels, properties } shape
   * that query-layer code expects (normalized format).
   */
  private normalizeValue(val: LbugValue): unknown {
    if (val !== null && typeof val === "object" && !Array.isArray(val) && "_label" in val) {
      // It's a NodeValue or RelValue from Kùzu
      const node = val as Record<string, unknown>;
      const label = node["_label"] as string | null;
      const { _label, _id, _src, _dst, ...rest } = node;
      return {
        labels: label ? [label] : [],
        properties: rest,
      };
    }
    return val;
  }

  /** Known node labels and relationship types that need prefixing in raw Cypher. */
  private static readonly KNOWN_LABELS = ["Symbol", "Cluster", "Process", "Metadata"];
  private static readonly KNOWN_REL_TYPES = ["CALLS", "IMPORTS", "INHERITS", "IMPLEMENTS", "CONTAINS", "HAS_STEP", "REFERENCES", "DEFINES"];

  /**
   * Inject prefix into bare node labels and relationship types in a Cypher query.
   * Replaces `:Symbol` with `:tpc_Symbol`, `[:HAS_STEP]` with `[:tpc_HAS_STEP]`, etc.
   * Skips labels that are already prefixed.
   */
  private prefixQuery(query: string): string {
    let q = query;
    for (const label of LadybugGraphAdapter.KNOWN_LABELS) {
      // Match :Label that isn't already prefixed (negative lookbehind for prefix)
      const re = new RegExp(`(:)(?!${this.prefix})(${label})\\b`, "g");
      q = q.replace(re, `$1${this.prefix}$2`);
    }
    for (const relType of LadybugGraphAdapter.KNOWN_REL_TYPES) {
      const re = new RegExp(`(:)(?!${this.prefix})(${relType})\\b`, "g");
      q = q.replace(re, `$1${this.prefix}$2`);
    }
    return q;
  }

  async runCypher<T>(
    query: string,
    params: Record<string, unknown> = {},
  ): Promise<T[]> {
    const prefixed = this.prefixQuery(query);
    const hasParams = Object.keys(params).length > 0;
    const rows = hasParams
      ? await this.execWithParams(prefixed, params)
      : await this.exec(prefixed);
    // Normalize NodeValue/RelValue objects in each row
    return rows.map((row) => {
      const normalized: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(row)) {
        normalized[key] = this.normalizeValue(val);
      }
      return normalized as T;
    });
  }

  async runCypherWrite(
    query: string,
    params: Record<string, unknown> = {},
  ): Promise<void> {
    const prefixed = this.prefixQuery(query);
    const hasParams = Object.keys(params).length > 0;
    if (hasParams) {
      await this.execWithParams(prefixed, params);
    } else {
      await this.exec(prefixed);
    }
  }
}
