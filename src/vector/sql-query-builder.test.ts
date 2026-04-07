/**
 * Unit tests for SqlQueryBuilder.
 * Requirements: 14.2, 14.3 (Prefix Support in Query Builders)
 */
import { describe, it, expect } from "vitest";
import { SqlQueryBuilder } from "./sql-query-builder.js";

// ─── getPrefix ────────────────────────────────────────────────────────────────

describe("SqlQueryBuilder.getPrefix", () => {
  it("returns the prefix passed to the constructor", () => {
    const builder = new SqlQueryBuilder("tpc_");
    expect(builder.getPrefix()).toBe("tpc_");
  });

  it("returns empty string when no prefix is given", () => {
    const builder = new SqlQueryBuilder("");
    expect(builder.getPrefix()).toBe("");
  });
});

// ─── select ───────────────────────────────────────────────────────────────────

describe("SqlQueryBuilder.select", () => {
  it("produces prefixed table name in SELECT output", () => {
    const sql = new SqlQueryBuilder("tpc_")
      .select(["id", "name"], "embeddings")
      .build();
    expect(sql).toBe("SELECT id, name FROM tpc_embeddings");
  });

  it("uses base table name when prefix is empty", () => {
    const sql = new SqlQueryBuilder("")
      .select(["id"], "embeddings")
      .build();
    expect(sql).toBe("SELECT id FROM embeddings");
  });
});

// ─── insert ───────────────────────────────────────────────────────────────────

describe("SqlQueryBuilder.insert", () => {
  it("produces prefixed table name in INSERT output", () => {
    const sql = new SqlQueryBuilder("tpc_")
      .insert("embeddings", { id: "1", val: "x" })
      .build();
    expect(sql).toBe("INSERT INTO tpc_embeddings (id, val) VALUES ($1, $2)");
  });

  it("uses base table name when prefix is empty", () => {
    const sql = new SqlQueryBuilder("")
      .insert("embeddings", { id: "1" })
      .build();
    expect(sql).toBe("INSERT INTO embeddings (id) VALUES ($1)");
  });
});

// ─── update ───────────────────────────────────────────────────────────────────

describe("SqlQueryBuilder.update", () => {
  it("produces prefixed table name in UPDATE output", () => {
    const sql = new SqlQueryBuilder("tpc_")
      .update("embeddings", { val: "x" })
      .build();
    expect(sql).toBe("UPDATE tpc_embeddings SET val = $1");
  });

  it("uses base table name when prefix is empty", () => {
    const sql = new SqlQueryBuilder("")
      .update("embeddings", { val: "x" })
      .build();
    expect(sql).toBe("UPDATE embeddings SET val = $1");
  });
});

// ─── delete ───────────────────────────────────────────────────────────────────

describe("SqlQueryBuilder.delete", () => {
  it("produces prefixed table name in DELETE output", () => {
    const sql = new SqlQueryBuilder("tpc_")
      .delete("embeddings")
      .build();
    expect(sql).toBe("DELETE FROM tpc_embeddings");
  });

  it("uses base table name when prefix is empty", () => {
    const sql = new SqlQueryBuilder("")
      .delete("embeddings")
      .build();
    expect(sql).toBe("DELETE FROM embeddings");
  });
});

// ─── build ────────────────────────────────────────────────────────────────────

describe("SqlQueryBuilder.build", () => {
  it("assembles a complete multi-clause SQL string joined by newlines", () => {
    const sql = new SqlQueryBuilder("tpc_")
      .select(["id"], "embeddings")
      .insert("metadata", { key: "v" })
      .build();
    expect(sql).toBe(
      "SELECT id FROM tpc_embeddings\nINSERT INTO tpc_metadata (key) VALUES ($1)",
    );
  });

  it("returns empty string when no clauses added", () => {
    const sql = new SqlQueryBuilder("tpc_").build();
    expect(sql).toBe("");
  });
});

// ─── fluent chaining ──────────────────────────────────────────────────────────

describe("SqlQueryBuilder fluent chaining", () => {
  it("each method returns the same builder instance", () => {
    const builder = new SqlQueryBuilder("tpc_");
    expect(builder.select(["id"], "t")).toBe(builder);
    expect(builder.insert("t", { a: 1 })).toBe(builder);
    expect(builder.update("t", { a: 1 })).toBe(builder);
    expect(builder.delete("t")).toBe(builder);
  });

  it("chains select, update, delete with prefix applied to each", () => {
    const sql = new SqlQueryBuilder("app_")
      .select(["id", "name"], "users")
      .update("users", { name: "bob" })
      .delete("sessions")
      .build();
    expect(sql).toBe(
      "SELECT id, name FROM app_users\nUPDATE app_users SET name = $1\nDELETE FROM app_sessions",
    );
  });
});
