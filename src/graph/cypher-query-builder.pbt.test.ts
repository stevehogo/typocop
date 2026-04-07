/**
 * Property-based tests for CypherQueryBuilder prefix consistency.
 *
 * **Validates: Requirements 3.2, 4.2, 5.2, 15.1, 15.2**
 * Property 9: Query Prefix Consistency
 */

import * as fc from "fast-check";
import { describe, it } from "vitest";
import { CypherQueryBuilder } from "./cypher-query-builder.js";

const validPrefix = fc.stringMatching(/^[a-z][a-z0-9_]{0,29}_$/);

const label = fc.constantFrom("Symbol", "File", "Cluster", "Process", "Metadata");
const relType = fc.constantFrom(
  "CALLS",
  "IMPORTS",
  "INHERITS",
  "IMPLEMENTS",
  "CONTAINS",
  "REFERENCES",
  "DEFINES",
);

describe("CypherQueryBuilder — Property 9: Query Prefix Consistency", () => {
  it("match() output contains prefix+label", () => {
    fc.assert(
      fc.property(validPrefix, label, (prefix, lbl) => {
        const query = new CypherQueryBuilder(prefix).match(lbl, "n").build();
        return query.includes(`${prefix}${lbl}`);
      }),
      { numRuns: 100 },
    );
  });

  it("relationship() output contains prefix+type", () => {
    fc.assert(
      fc.property(validPrefix, relType, (prefix, type) => {
        const query = new CypherQueryBuilder(prefix).relationship(type, "out").build();
        return query.includes(`${prefix}${type}`);
      }),
      { numRuns: 100 },
    );
  });

  it("merge() output contains prefix+label", () => {
    fc.assert(
      fc.property(validPrefix, label, (prefix, lbl) => {
        const query = new CypherQueryBuilder(prefix).merge(lbl, { id: "1" }).build();
        return query.includes(`${prefix}${lbl}`);
      }),
      { numRuns: 100 },
    );
  });

  it("create() output contains prefix+label", () => {
    fc.assert(
      fc.property(validPrefix, label, (prefix, lbl) => {
        const query = new CypherQueryBuilder(prefix).create(lbl, { id: "1" }).build();
        return query.includes(`${prefix}${lbl}`);
      }),
      { numRuns: 100 },
    );
  });

  it("getPrefix() returns the exact prefix passed to constructor", () => {
    fc.assert(
      fc.property(validPrefix, (prefix) => {
        return new CypherQueryBuilder(prefix).getPrefix() === prefix;
      }),
      { numRuns: 100 },
    );
  });

  it("all clauses in a chained query use the same prefix", () => {
    fc.assert(
      fc.property(validPrefix, label, relType, (prefix, lbl, type) => {
        const query = new CypherQueryBuilder(prefix)
          .match(lbl, "a")
          .relationship(type, "out")
          .match(lbl, "b")
          .build();

        // Every occurrence of the label or type must be prefixed
        const unprefixedLabel = new RegExp(`(?<!${prefix})\\b${lbl}\\b`);
        const unprefixedType = new RegExp(`(?<!${prefix})\\b${type}\\b`);

        return !unprefixedLabel.test(query) && !unprefixedType.test(query);
      }),
      { numRuns: 100 },
    );
  });
});
