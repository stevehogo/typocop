/**
 * Property-based test: prefix isolation for LadybugGraphAdapter.
 *
 * **Validates: Requirements 2.2**
 *
 * Property 2 from design-correctness.md:
 * ∀ prefix P, ∀ query Q: results(Q, P) ∩ results(Q, P') = ∅ where P ≠ P'.
 *
 * Queries with prefix P never return data from prefix P'.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import type { LbugValue, NodeValue, RelValue } from "@ladybugdb/core";
import { LadybugGraphAdapter } from "./ladybug-graph-adapter.js";

// ─── In-memory graph store for property testing ──────────────────────────────

/**
 * Simulates LadybugDB's Connection.query() API with an in-memory store so we
 * can verify prefix isolation without a real database.
 */
function createInMemoryConnection() {
  const nodes = new Map<string, { label: string; properties: Record<string, unknown> }>();
  const relationships: Array<{
    type: string;
    properties: Record<string, unknown>;
    fromId: string;
    toId: string;
  }> = [];

  const connection = {
    query: async (queryStr: string): Promise<{ getAll: () => Promise<Record<string, LbugValue>[]> }> => {
      // Parse MERGE node: MERGE (n:PREFIX_Label {id: "..."}) SET n = {...}
      const mergeNodeMatch = queryStr.match(/MERGE\s+\(n:(\w+)\s+\{id:\s*"([^"]+)"\}\)\s+SET\s+n\s*=/);
      if (mergeNodeMatch) {
        const label = mergeNodeMatch[1];
        const id = mergeNodeMatch[2];
        // Extract props from SET n = {...}
        const propsMatch = queryStr.match(/SET\s+n\s*=\s*\{([^}]*)\}/);
        const props: Record<string, unknown> = { id };
        if (propsMatch) {
          const propsStr = propsMatch[1];
          for (const pair of propsStr.split(",")) {
            const [k, v] = pair.split(":").map((s) => s.trim());
            if (k && v) {
              props[k] = v.replace(/^"|"$/g, "");
            }
          }
        }
        const key = `${label}::${id}`;
        nodes.set(key, { label, properties: props });
        return { getAll: async () => [] };
      }

      // Parse MERGE relationship: MATCH (a {id: "..."}), (b {id: "..."}) MERGE (a)-[r:TYPE]->(b)
      const mergeRelMatch = queryStr.match(/MERGE\s+\(a\)-\[r:(\w+)\]->\(b\)/);
      if (mergeRelMatch) {
        const type = mergeRelMatch[1];
        const fromMatch = queryStr.match(/a\s*\{id:\s*"([^"]+)"\}/);
        const toMatch = queryStr.match(/b\s*\{id:\s*"([^"]+)"\}/);
        const fromId = fromMatch ? fromMatch[1] : "";
        const toId = toMatch ? toMatch[1] : "";
        relationships.push({ type, properties: {}, fromId, toId });
        return { getAll: async () => [] };
      }

      // Parse MATCH node query: MATCH (n:LABEL) ... RETURN n
      const matchNodeMatch = queryStr.match(/MATCH\s+\(n:(\w+)\)/);
      if (matchNodeMatch && queryStr.includes("RETURN n")) {
        const label = matchNodeMatch[1];
        const rows: Record<string, LbugValue>[] = [...nodes.entries()]
          .filter(([key]) => key.startsWith(`${label}::`))
          .map(([, node]) => ({
            n: {
              _label: node.label,
              _id: { offset: 0, table: 0 },
              ...node.properties,
            } as NodeValue,
          }));
        return { getAll: async () => rows };
      }

      // Parse MATCH relationship query:
      // - MATCH ()-[r:TYPE]->() RETURN r
      // - MATCH (source)-[r:TYPE]->(target) RETURN r, ...
      const matchRelMatch = queryStr.match(/MATCH\s+\([^)]*\)-\[r:(\w+)\]->\([^)]*\)\s+RETURN\s+r/);
      if (matchRelMatch) {
        const type = matchRelMatch[1];
        const rows: Record<string, LbugValue>[] = relationships
          .filter((r) => r.type === type)
          .map((r) => ({
            r: {
              _label: r.type,
              _src: null,
              _dst: null,
              _id: 0,
              ...r.properties,
            } as RelValue,
          }));
        return { getAll: async () => rows };
      }

      return { getAll: async () => [] };
    },
    init: async () => {},
    close: async () => {},
  };

  return { connection, nodes, relationships };
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Generate a valid prefix: lowercase letters, ending with _. */
const prefixArbitrary = fc
  .stringMatching(/^[a-z]{2,8}$/)
  .map((s) => s + "_");

/** Generate a pair of distinct prefixes. */
const distinctPrefixPair = fc
  .tuple(prefixArbitrary, prefixArbitrary)
  .filter(([a, b]) => a !== b);

/** Generate a simple node label. */
const labelArbitrary = fc.constantFrom("Symbol", "File", "Cluster", "Process");

/** Generate a simple relationship type. */
const relTypeArbitrary = fc.constantFrom("CALLS", "IMPORTS", "CONTAINS", "INHERITS");

/** Generate a simple node id. */
const nodeIdArbitrary = fc
  .stringMatching(/^[a-z0-9]{1,12}$/)
  .map((s) => "id_" + s);

// ─── Property Tests ──────────────────────────────────────────────────────────

describe("LadybugGraphAdapter — prefix isolation property", () => {
  it("nodes written with prefix P are never visible when querying with prefix P'", async () => {
    await fc.assert(
      fc.asyncProperty(
        distinctPrefixPair,
        labelArbitrary,
        nodeIdArbitrary,
        async ([prefixP, prefixPPrime], label, nodeId) => {
          const { connection } = createInMemoryConnection();

          const adapterP = new LadybugGraphAdapter(connection as never, prefixP);
          const adapterPPrime = new LadybugGraphAdapter(connection as never, prefixPPrime);

          // Write a node with prefix P
          await adapterP.createNode(label, { id: nodeId, name: "test" });

          // Query with prefix P' — should find nothing
          const resultsPPrime = await adapterPPrime.queryNodes(label);
          expect(resultsPPrime).toHaveLength(0);

          // Query with prefix P — should find the node
          const resultsP = await adapterP.queryNodes(label);
          expect(resultsP.length).toBeGreaterThanOrEqual(1);
          expect(resultsP.some((n) => n.properties["id"] === nodeId)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("relationships written with prefix P are never visible when querying with prefix P'", async () => {
    await fc.assert(
      fc.asyncProperty(
        distinctPrefixPair,
        relTypeArbitrary,
        fc.tuple(nodeIdArbitrary, nodeIdArbitrary).filter(([a, b]) => a !== b),
        async ([prefixP, prefixPPrime], relType, [fromId, toId]) => {
          const { connection } = createInMemoryConnection();

          const adapterP = new LadybugGraphAdapter(connection as never, prefixP);
          const adapterPPrime = new LadybugGraphAdapter(connection as never, prefixPPrime);

          // Write nodes and relationship with prefix P
          await adapterP.createNode("Symbol", { id: fromId });
          await adapterP.createNode("Symbol", { id: toId });
          await adapterP.createRelationship(fromId, toId, relType);

          // Query relationships with prefix P' — should find nothing
          const resultsPPrime = await adapterPPrime.queryRelationships(relType);
          expect(resultsPPrime).toHaveLength(0);

          // Query relationships with prefix P — should find the relationship
          const resultsP = await adapterP.queryRelationships(relType);
          expect(resultsP.length).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});
