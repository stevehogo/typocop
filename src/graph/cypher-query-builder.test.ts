import { describe, it, expect } from "vitest";
import { CypherQueryBuilder } from "./cypher-query-builder.js";

describe("CypherQueryBuilder", () => {
  describe("getPrefix()", () => {
    it("returns the prefix passed to constructor", () => {
      const builder = new CypherQueryBuilder("tpc_");
      expect(builder.getPrefix()).toBe("tpc_");
    });

    it("returns empty string when no prefix given", () => {
      const builder = new CypherQueryBuilder("");
      expect(builder.getPrefix()).toBe("");
    });
  });

  describe("match()", () => {
    it("produces prefixed label in output", () => {
      const result = new CypherQueryBuilder("tpc_").match("Symbol", "n").build();
      expect(result).toBe("MATCH (n:tpc_Symbol)");
    });

    it("produces unprefixed label when prefix is empty", () => {
      const result = new CypherQueryBuilder("").match("Symbol", "n").build();
      expect(result).toBe("MATCH (n:Symbol)");
    });
  });

  describe("relationship()", () => {
    it("produces prefixed outgoing relationship type", () => {
      const result = new CypherQueryBuilder("tpc_").relationship("CALLS", "out").build();
      expect(result).toBe("-[:tpc_CALLS]->");
    });

    it("produces prefixed incoming relationship type", () => {
      const result = new CypherQueryBuilder("tpc_").relationship("CALLS", "in").build();
      expect(result).toBe("<-[:tpc_CALLS]-");
    });

    it("produces unprefixed type when prefix is empty", () => {
      const result = new CypherQueryBuilder("").relationship("CALLS", "out").build();
      expect(result).toBe("-[:CALLS]->");
    });
  });

  describe("merge()", () => {
    it("produces prefixed label in output", () => {
      const result = new CypherQueryBuilder("tpc_").merge("Symbol", { id: "1" }).build();
      expect(result).toBe('MERGE (n:tpc_Symbol {id: "1"})');
    });

    it("produces unprefixed label when prefix is empty", () => {
      const result = new CypherQueryBuilder("").merge("Symbol", { id: "1" }).build();
      expect(result).toBe('MERGE (n:Symbol {id: "1"})');
    });
  });

  describe("create()", () => {
    it("produces prefixed label in output", () => {
      const result = new CypherQueryBuilder("tpc_").create("File", { path: "/foo" }).build();
      expect(result).toBe('CREATE (n:tpc_File {path: "/foo"})');
    });

    it("produces unprefixed label when prefix is empty", () => {
      const result = new CypherQueryBuilder("").create("File", { path: "/foo" }).build();
      expect(result).toBe('CREATE (n:File {path: "/foo"})');
    });
  });

  describe("build()", () => {
    it("assembles a complete Cypher string from multiple clauses", () => {
      const result = new CypherQueryBuilder("tpc_")
        .match("Symbol", "n")
        .merge("File", { path: "/foo" })
        .build();
      expect(result).toBe('MATCH (n:tpc_Symbol)\nMERGE (n:tpc_File {path: "/foo"})');
    });

    it("returns empty string when no clauses added", () => {
      const result = new CypherQueryBuilder("tpc_").build();
      expect(result).toBe("");
    });
  });

  describe("fluent chaining", () => {
    it("chains match, relationship, and build correctly", () => {
      const result = new CypherQueryBuilder("tpc_")
        .match("Symbol", "a")
        .relationship("CALLS", "out")
        .match("Symbol", "b")
        .build();
      expect(result).toBe(
        "MATCH (a:tpc_Symbol)\n-[:tpc_CALLS]->\nMATCH (b:tpc_Symbol)"
      );
    });

    it("each method returns the same builder instance", () => {
      const builder = new CypherQueryBuilder("tpc_");
      const result = builder.match("Symbol", "n");
      expect(result).toBe(builder);
    });
  });
});
