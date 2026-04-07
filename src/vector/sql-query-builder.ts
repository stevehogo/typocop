/**
 * SqlQueryBuilder — fluent SQL query builder with schema prefix support.
 * Requirements: 14.2, 14.3 (Prefix Support in Query Builders)
 */

type SqlClause = string;

/**
 * Builds SQL statements with a configurable table name prefix.
 * Each method appends a clause; build() joins them with newlines.
 * Empty prefix uses base table names unchanged.
 */
export class SqlQueryBuilder {
  private readonly prefix: string;
  private readonly clauses: SqlClause[] = [];

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  /** Returns the prefix passed to the constructor. */
  getPrefix(): string {
    return this.prefix;
  }

  /** Appends a SELECT clause with a prefixed table name. */
  select(columns: string[], table: string): this {
    const prefixedTable = `${this.prefix}${table}`;
    this.clauses.push(`SELECT ${columns.join(", ")} FROM ${prefixedTable}`);
    return this;
  }

  /** Appends an INSERT clause with a prefixed table name. */
  insert(table: string, values: Record<string, unknown>): this {
    const prefixedTable = `${this.prefix}${table}`;
    const keys = Object.keys(values);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
    this.clauses.push(
      `INSERT INTO ${prefixedTable} (${keys.join(", ")}) VALUES (${placeholders})`,
    );
    return this;
  }

  /** Appends an UPDATE clause with a prefixed table name. */
  update(table: string, values: Record<string, unknown>): this {
    const prefixedTable = `${this.prefix}${table}`;
    const assignments = Object.keys(values)
      .map((key, i) => `${key} = $${i + 1}`)
      .join(", ");
    this.clauses.push(`UPDATE ${prefixedTable} SET ${assignments}`);
    return this;
  }

  /** Appends a DELETE clause with a prefixed table name. */
  delete(table: string): this {
    const prefixedTable = `${this.prefix}${table}`;
    this.clauses.push(`DELETE FROM ${prefixedTable}`);
    return this;
  }

  /** Assembles all clauses into a single SQL string joined by newlines. */
  build(): string {
    return this.clauses.join("\n");
  }
}
