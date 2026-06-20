/**
 * LadybugGraphAdapter — GraphAdapter implementation backed by LadybugDB's
 * Cypher-compatible Connection.query() API with prefix-aware label/type management.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */

import type { Connection, LbugValue, NodeValue, RelValue } from "@ladybugdb/core";
import type { GraphAdapter, GraphNode, GraphRelationship } from "../../core/ports/persistence.js";

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

  private isMissingTableError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("Table ") && message.includes(" does not exist");
  }

  private async execWithSchemaRetry(query: string): Promise<Record<string, LbugValue>[]> {
    try {
      return await this.exec(query);
    } catch (error) {
      if (!this.isMissingTableError(error)) {
        throw error;
      }
      await this.initializeSchema(true);
      return this.exec(query);
    }
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

  /** Parameterized exec mirroring {@link execWithSchemaRetry}: on a missing-table
   *  error, recreate the schema and retry once. */
  private async execWithParamsSchemaRetry(
    query: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, LbugValue>[]> {
    try {
      return await this.execWithParams(query, params);
    } catch (error) {
      if (!this.isMissingTableError(error)) {
        throw error;
      }
      await this.initializeSchema(true);
      return this.execWithParams(query, params);
    }
  }

  /**
   * Create all required node and relationship tables.
   * LadybugDB (Kùzu) requires explicit schema before data insertion.
   * Safe to call multiple times — uses IF NOT EXISTS.
   */
  async initializeSchema(force = false): Promise<void> {
    if (this.schemaInitialized && !force) return;

    const nodeLabels = ["Symbol", "Cluster", "Process", "Metadata", "ExternalDependency"];
    for (const label of nodeLabels) {
      const tbl = this.prefixLabel(label);
      await this.exec(
        `CREATE NODE TABLE IF NOT EXISTS ${tbl} (id STRING, name STRING, kind STRING, filePath STRING, startLine STRING, startColumn STRING, endLine STRING, endColumn STRING, visibility STRING, signature STRING, documentation STRING, cyclomatic STRING, cognitive STRING, maxLoopDepth STRING, responseKeys STRING, accessedKeys STRING, category STRING, confidence STRING, symbolCount STRING, entryPoint STRING, stepCount STRING, key STRING, timestamp STRING, aliases STRING, ecosystem STRING, PRIMARY KEY(id))`,
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

    const ext = this.prefixLabel("ExternalDependency");
    const dependsOnTbl = this.prefixType("DEPENDS_ON");
    await this.exec(`CREATE REL TABLE IF NOT EXISTS ${dependsOnTbl} (FROM ${sym} TO ${ext})`);

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
    const props = properties as { id: string } & Record<string, unknown>;
    // Exclude 'id' from SET clause since it's the primary key (cannot be updated)
    const propEntries = Object.entries(props).filter(([k]) => k !== "id");
    const setClause = propEntries.length > 0
      ? "SET n = {" + propEntries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ") + "}"
      : "";
    await this.execWithSchemaRetry(`MERGE (n:${prefixedLabel} {id: "${props.id}"}) ${setClause}`);
  }

  /**
   * Batch fast-path: insert many same-label nodes in ONE parameterized query.
   * The pipeline already chunks by DB_WRITE_BATCH_SIZE, so `nodes` is a bounded
   * chunk — we do NOT re-chunk here. Columns are derived from the union of row
   * keys (excluding the primary key `id`); within a label the pipeline sends
   * uniform rows, but unioning is defensive against minor shape drift.
   */
  async createNodes(
    label: string,
    nodes: ReadonlyArray<Record<string, unknown>>,
  ): Promise<void> {
    if (nodes.length === 0) return;
    const prefixedLabel = this.prefixLabel(label);

    // Union of non-id keys across all rows (defensive; rows are normally uniform).
    const columns = new Set<string>();
    for (const node of nodes) {
      for (const key of Object.keys(node)) {
        if (key !== "id") columns.add(key);
      }
    }
    const cols = [...columns];
    const setClause = cols.length > 0
      ? "SET " + cols.map((c) => `n.${c} = row.${c}`).join(", ")
      : "";

    const query =
      `UNWIND $rows AS row MERGE (n:${prefixedLabel} {id: row.id}) ${setClause}`.trimEnd();
    await this.execWithParamsSchemaRetry(query, { rows: nodes });
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
    DEPENDS_ON: ["Symbol", "ExternalDependency"],
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
    await this.execWithSchemaRetry(
      `MATCH (a:${fromLabel} {id: "${fromId}"}), (b:${toLabel} {id: "${toId}"}) MERGE (a)-[r:${prefixedType}]->(b)${setClause}`,
    );
  }

  /**
   * Batch fast-path: insert many same-type relationships in ONE parameterized
   * query. `relationships` is a bounded chunk (pipeline-chunked) — not re-chunked
   * here. Only properties declared in the rel table schema (REL_SCHEMA_PROPS) are
   * SET; everything else is dropped to satisfy Kùzu's strict rel schema.
   */
  async createRelationships(
    type: string,
    relationships: ReadonlyArray<{
      readonly fromId: string;
      readonly toId: string;
      readonly properties?: Record<string, unknown>;
    }>,
  ): Promise<void> {
    if (relationships.length === 0) return;
    const prefixedType = this.prefixType(type);
    const labels = LadybugGraphAdapter.REL_LABEL_MAP[type] ?? ["Symbol", "Symbol"];
    const fromLabel = this.prefixLabel(labels[0]);
    const toLabel = this.prefixLabel(labels[1]);

    const allowed = LadybugGraphAdapter.REL_SCHEMA_PROPS[type] ?? new Set<string>();
    const props = [...allowed];
    const setClause = props.length > 0
      ? " ON CREATE SET " + props.map((p) => `r.${p} = rel.${p}`).join(", ") +
        " ON MATCH SET " + props.map((p) => `r.${p} = rel.${p}`).join(", ")
      : "";

    // Flatten each row to { fromId, toId, <allowed props> } so the prepared
    // statement binds a uniform struct shape.
    const rels = relationships.map((rel) => {
      const flat: Record<string, unknown> = { fromId: rel.fromId, toId: rel.toId };
      for (const p of props) {
        flat[p] = rel.properties?.[p];
      }
      return flat;
    });

    // NOTE: Kùzu rejects struct-field access inside a node-pattern property map
    // (e.g. `(a {id: rel.fromId})`) for an UNWIND'd struct param — it throws
    // `unordered_map::at`. Bind the ids in a WHERE clause instead; the planner
    // resolves both endpoints via their primary-key index, so this is not a
    // cartesian scan.
    const query =
      `UNWIND $rels AS rel MATCH (a:${fromLabel}), (b:${toLabel}) ` +
      `WHERE a.id = rel.fromId AND b.id = rel.toId ` +
      `MERGE (a)-[r:${prefixedType}]->(b)${setClause}`;
    await this.execWithParamsSchemaRetry(query, { rels });
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

    const rows = await this.execWithSchemaRetry(
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
    const rows = await this.execWithSchemaRetry(
      `MATCH (source)-[r:${prefixedType}]->(target) RETURN r, source.id AS sourceId, target.id AS targetId`,
    );

    return rows.map((row) => {
      const r = row["r"] as RelValue;
      return {
        type: r._label ?? prefixedType,
        properties: { ...r } as Record<string, unknown>,
        sourceId: typeof row["sourceId"] === "string" ? row["sourceId"] : undefined,
        targetId: typeof row["targetId"] === "string" ? row["targetId"] : undefined,
      };
    });
  }

  async deleteNodesByLabel(label: string): Promise<number> {
    const prefixedLabel = this.prefixLabel(label);
    // Count before deleting so the reported clearing stats are accurate (mirrors
    // the vector adapter's deleteAll). The DETACH DELETE itself always ran; only
    // the returned count was previously hardcoded to 0.
    const countRows = await this.execWithSchemaRetry(
      `MATCH (n:${prefixedLabel}) RETURN count(n) as count`,
    );
    const count = Number(countRows[0]?.count ?? 0);
    await this.execWithSchemaRetry(`MATCH (n:${prefixedLabel}) DETACH DELETE n`);
    return count;
  }

  /**
   * A4 diff-write: DETACH DELETE every Symbol node whose `filePath` is in
   * `paths`, returning the count deleted. Parameterized (`$paths`) and routed
   * through {@link execWithParamsSchemaRetry} so a missing-table error recreates
   * the schema and retries once, mirroring the other write paths. An empty
   * `paths` is a no-op (nothing matches `IN []`), so we short-circuit to 0.
   *
   * `DETACH DELETE` also drops the changed file's inbound cross-file edges; the
   * pipeline re-emits those from the global resolution each run (keyed by
   * `logicalKey`), so they restore.
   */
  async deleteSymbolsByFilePaths(paths: readonly string[]): Promise<number> {
    if (paths.length === 0) return 0;
    const prefixedLabel = this.prefixLabel("Symbol");
    const pathList = [...paths];
    const countRows = await this.execWithParamsSchemaRetry(
      `MATCH (n:${prefixedLabel}) WHERE n.filePath IN $paths RETURN count(n) as count`,
      { paths: pathList },
    );
    const count = Number(countRows[0]?.count ?? 0);
    await this.execWithParamsSchemaRetry(
      `MATCH (n:${prefixedLabel}) WHERE n.filePath IN $paths DETACH DELETE n`,
      { paths: pathList },
    );
    return count;
  }

  async deleteRelationshipsByType(type: string): Promise<number> {
    const prefixedType = this.prefixType(type);
    const countRows = await this.execWithSchemaRetry(
      `MATCH ()-[r:${prefixedType}]->() RETURN count(r) as count`,
    );
    const count = Number(countRows[0]?.count ?? 0);
    await this.execWithSchemaRetry(`MATCH ()-[r:${prefixedType}]->() DELETE r`);
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
  private static readonly KNOWN_LABELS = ["Symbol", "Cluster", "Process", "Metadata", "ExternalDependency"];
  private static readonly KNOWN_REL_TYPES = ["CALLS", "IMPORTS", "INHERITS", "IMPLEMENTS", "CONTAINS", "HAS_STEP", "REFERENCES", "DEFINES", "DEPENDS_ON"];

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
    const rows = await this.execWithSchemaRetry(prefixed);
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
    // When params are provided, bind them via the parameterized (prepare/execute)
    // path; the previous implementation silently ignored them.
    if (Object.keys(params).length > 0) {
      await this.execWithParamsSchemaRetry(prefixed, params);
      return;
    }
    await this.execWithSchemaRetry(prefixed);
  }
}
