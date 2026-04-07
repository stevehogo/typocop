/**
 * Fluent Cypher query builder with prefix support.
 * Requirements: 14.1, 14.3
 */

type Direction = "in" | "out";

interface QueryPart {
  readonly clause: string;
}

/**
 * Builds Cypher queries with automatic label/type prefixing.
 *
 * Requirements: 14.1, 14.3
 */
export class CypherQueryBuilder {
  private readonly prefix: string;
  private readonly parts: QueryPart[] = [];

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  /** Prepend prefix to a label or relationship type. */
  private prefixed(name: string): string {
    return `${this.prefix}${name}`;
  }

  /** Serialize properties object to Cypher map literal. */
  private serializeProps(properties: Record<string, unknown>): string {
    const entries = Object.entries(properties)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(", ");
    return `{${entries}}`;
  }

  /**
   * Add a MATCH clause with a prefixed label.
   * match('Symbol', 'n') → MATCH (n:tpc_Symbol)
   */
  match(label: string, alias: string): CypherQueryBuilder {
    this.parts.push({ clause: `MATCH (${alias}:${this.prefixed(label)})` });
    return this;
  }

  /**
   * Add a relationship segment with a prefixed type.
   * relationship('CALLS', 'out') → -[:tpc_CALLS]->
   */
  relationship(type: string, direction: Direction): CypherQueryBuilder {
    const rel = `[:${this.prefixed(type)}]`;
    const clause = direction === "out" ? `-${rel}->` : `<-${rel}-`;
    this.parts.push({ clause });
    return this;
  }

  /**
   * Add a MERGE clause with a prefixed label.
   * merge('Symbol', {id: '1'}) → MERGE (n:tpc_Symbol {id: "1"})
   */
  merge(label: string, properties: Record<string, unknown>): CypherQueryBuilder {
    const props = this.serializeProps(properties);
    this.parts.push({ clause: `MERGE (n:${this.prefixed(label)} ${props})` });
    return this;
  }

  /**
   * Add a CREATE clause with a prefixed label.
   * create('File', {path: '/foo'}) → CREATE (n:tpc_File {path: "/foo"})
   */
  create(label: string, properties: Record<string, unknown>): CypherQueryBuilder {
    const props = this.serializeProps(properties);
    this.parts.push({ clause: `CREATE (n:${this.prefixed(label)} ${props})` });
    return this;
  }

  /** Return the prefix used by this builder. */
  getPrefix(): string {
    return this.prefix;
  }

  /** Assemble all parts into a single Cypher string. */
  build(): string {
    return this.parts.map((p) => p.clause).join("\n");
  }
}
