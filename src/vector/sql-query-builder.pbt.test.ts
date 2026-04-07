/**
 * Property-based tests for SqlQueryBuilder prefix consistency.
 *
 * **Validates: Requirements 3.2, 15.1, 15.2**
 * Property 9: Query Prefix Consistency
 */

import * as fc from "fast-check";
import { describe, it } from "vitest";
import { SqlQueryBuilder } from "./sql-query-builder.js";

const validPrefix = fc.stringMatching(/^[a-z][a-z0-9_]{0,29}_$/);

const table = fc.constantFrom("embeddings", "metadata");

describe("SqlQueryBuilder — Property 9: Query Prefix Consistency", () => {
  it("select() output contains prefix+table", () => {
    fc.assert(
      fc.property(validPrefix, table, (prefix, tbl) => {
        const query = new SqlQueryBuilder(prefix).select(["*"], tbl).build();
        return query.includes(`${prefix}${tbl}`);
      }),
      { numRuns: 100 },
    );
  });

  it("insert() output contains prefix+table", () => {
    fc.assert(
      fc.property(validPrefix, table, (prefix, tbl) => {
        const query = new SqlQueryBuilder(prefix).insert(tbl, { id: "1" }).build();
        return query.includes(`${prefix}${tbl}`);
      }),
      { numRuns: 100 },
    );
  });

  it("update() output contains prefix+table", () => {
    fc.assert(
      fc.property(validPrefix, table, (prefix, tbl) => {
        const query = new SqlQueryBuilder(prefix).update(tbl, { id: "1" }).build();
        return query.includes(`${prefix}${tbl}`);
      }),
      { numRuns: 100 },
    );
  });

  it("delete() output contains prefix+table", () => {
    fc.assert(
      fc.property(validPrefix, table, (prefix, tbl) => {
        const query = new SqlQueryBuilder(prefix).delete(tbl).build();
        return query.includes(`${prefix}${tbl}`);
      }),
      { numRuns: 100 },
    );
  });

  it("getPrefix() returns the exact prefix passed to constructor", () => {
    fc.assert(
      fc.property(validPrefix, (prefix) => {
        return new SqlQueryBuilder(prefix).getPrefix() === prefix;
      }),
      { numRuns: 100 },
    );
  });

  it("all clauses in a chained query use the same prefix", () => {
    fc.assert(
      fc.property(validPrefix, table, (prefix, tbl) => {
        const query = new SqlQueryBuilder(prefix)
          .select(["id"], tbl)
          .insert(tbl, { id: "1" })
          .update(tbl, { id: "2" })
          .delete(tbl)
          .build();

        // Every line referencing the table must use the prefixed name
        const lines = query.split("\n").filter((l) => l.includes(tbl));
        return lines.every((line) => line.includes(`${prefix}${tbl}`));
      }),
      { numRuns: 100 },
    );
  });
});
