/**
 * Tests for runCypherTolerant — the data-touch read tools' degrade-to-empty
 * guard. A live MCP smoke test surfaced that a DB whose schema predates the
 * data-touch REL tables throws a Kùzu "Table X does not exist" binder error
 * (local-adapter form) or a gRPC-wrapped form (remote adapter) rather than
 * returning zero rows, violating each tool's documented degrade-to-empty
 * contract. runCypherTolerant turns ONLY that error into an empty result; any
 * other error still propagates.
 */
import { describe, it, expect, vi } from "vitest";
import type { GraphAdapter } from "../../core/ports/persistence.js";
import { runCypherTolerant } from "./graph-helpers.js";

function adapterWith(runCypher: GraphAdapter["runCypher"]): GraphAdapter {
  return {
    runCypher,
    runCypherWrite: (async () => []) as unknown as GraphAdapter["runCypherWrite"],
  } as unknown as GraphAdapter;
}

describe("runCypherTolerant", () => {
  it("returns the rows when the query succeeds", async () => {
    const graph = adapterWith((async () => [{ a: 1 }, { a: 2 }]) as unknown as GraphAdapter["runCypher"]);
    expect(await runCypherTolerant(graph, "MATCH (n) RETURN n")).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("returns [] when the adapter yields null/undefined", async () => {
    const graph = adapterWith((async () => undefined) as unknown as GraphAdapter["runCypher"]);
    expect(await runCypherTolerant(graph, "MATCH (n) RETURN n")).toEqual([]);
  });

  it("degrades a missing-table binder error to [] (local-adapter message form)", async () => {
    const graph = adapterWith((async () => {
      throw new Error("Binder exception: Table HANDLES_ROUTE does not exist.");
    }) as unknown as GraphAdapter["runCypher"]);
    expect(await runCypherTolerant(graph, "MATCH ()-[:HANDLES_ROUTE]->() RETURN 1")).toEqual([]);
  });

  it("degrades a missing-table error wrapped in a gRPC/string error to []", async () => {
    const graph = adapterWith((async () => {
      // Mirrors the remote connection-server gRPC error string seen live.
      throw "13 INTERNAL: {\"message\":\"Query preparation failed: Binder exception: Table READS_FROM_DB does not exist.\"}";
    }) as unknown as GraphAdapter["runCypher"]);
    expect(await runCypherTolerant(graph, "MATCH ()-[:READS_FROM_DB]->() RETURN 1")).toEqual([]);
  });

  it("rethrows a non-missing-table error", async () => {
    const boom = new Error("Connection refused");
    const graph = adapterWith((async () => {
      throw boom;
    }) as unknown as GraphAdapter["runCypher"]);
    await expect(runCypherTolerant(graph, "MATCH (n) RETURN n")).rejects.toThrow("Connection refused");
  });

  it("does NOT swallow a generic 'does not exist' error lacking a table reference", async () => {
    const graph = adapterWith((async () => {
      throw new Error("Property foo does not exist on this node");
    }) as unknown as GraphAdapter["runCypher"]);
    await expect(runCypherTolerant(graph, "MATCH (n) RETURN n.foo")).rejects.toThrow("does not exist");
  });
});
