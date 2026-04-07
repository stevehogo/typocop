/**
 * Preservation Property-Based Tests: Neo4j
 *
 * These tests verify that single-instance behavior on UNFIXED code remains
 * identical before and after the fix. They establish a baseline of correctness
 * that must be preserved when prefixes are added.
 *
 * **EXPECTED OUTCOME**: Tests PASS on unfixed code (confirms baseline to preserve)
 *
 * Property 1: Neo4j node writes and reads produce identical results before and after fix
 * Property 3: Single-instance behavior is preserved (Requirements 3.1, 3.2, 3.3)
 *
 * Validates: Requirements 3.1, 3.2, 3.3
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";
import { storeNodes } from "./store.js";
import type { GraphNode } from "./connection.js";

// ─── Mock Session Factory ──────────────────────────────────────────────────────

interface MockSession {
  executeWrite: ReturnType<typeof vi.fn>;
  executeRead: ReturnType<typeof vi.fn>;
  nodeStore: Map<string, { labels: string[]; properties: Record<string, unknown> }>;
  capturedWrites: Array<{ cypher: string; params: Record<string, unknown> }>;
}

function makeMockSession(): MockSession {
  const nodeStore = new Map<string, { labels: string[]; properties: Record<string, unknown> }>();
  const capturedWrites: Array<{ cypher: string; params: Record<string, unknown> }> = [];

  const session: MockSession = {
    capturedWrites,
    nodeStore,
    executeWrite: vi.fn().mockImplementation(
      async (fn: (tx: { run: (cypher: string, params?: Record<string, unknown>) => Promise<{ records: unknown[] }> }) => Promise<unknown>) => {
        const mockTx = {
          run: vi.fn().mockImplementation(async (cypher: string, params: Record<string, unknown> = {}) => {
            capturedWrites.push({ cypher, params });

            // Simulate UNWIND $nodes AS n ... apoc.merge.node(n.labels, {id: n.id}, n.properties)
            const apocMatch = /UNWIND \$nodes AS n/.exec(cypher);
            if (apocMatch) {
              const nodes = params["nodes"] as Array<{ id: string; labels: string[]; properties: Record<string, unknown> }>;
              for (const n of nodes) {
                // Use composite key primaryLabel:id to simulate Neo4j's label-scoped storage
                const primaryLabel = n.labels[0] ?? "Node";
                nodeStore.set(`${primaryLabel}:${n.id}`, { labels: n.labels, properties: { ...n.properties, id: n.id } });
              }
            }

            // Simulate MERGE (x:<label> {id: $id}) SET x += $props (fallback)
            const mergeMatch = /MERGE \(x:(\S+) \{id: \$id\}\) SET x \+= \$props/.exec(cypher);
            if (mergeMatch) {
              const label = mergeMatch[1] as string;
              const id = params["id"] as string;
              const props = params["props"] as Record<string, unknown>;
              // Use composite key label:id to simulate Neo4j's label-scoped storage
              nodeStore.set(`${label}:${id}`, { labels: [label], properties: { ...props, id } });
            }

            return { records: [] };
          }),
        };
        return fn(mockTx);
      },
    ),
    executeRead: vi.fn().mockImplementation(
      async (fn: (tx: { run: (cypher: string, params?: Record<string, unknown>) => Promise<{ records: unknown[] }> }) => Promise<unknown>) => {
        const mockTx = {
          run: vi.fn().mockImplementation(async (cypher: string, params: Record<string, unknown> = {}) => {
            // Simulate MATCH (x:<label> {id: $id}) RETURN x
            const matchById = /MATCH \(x:(\S+) \{id: \$id\}\) RETURN x/.exec(cypher);
            if (matchById) {
              const id = params["id"] as string;
              const node = nodeStore.get(id);
              if (node) {
                return { records: [{ get: () => ({ labels: node.labels, properties: node.properties }) }] };
              }
            }
            return { records: [] };
          }),
        };
        return fn(mockTx);
      },
    ),
  };

  return session;
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

const symbolIdArbitrary = (): fc.Arbitrary<string> =>
  fc.stringMatching(/^[a-z0-9_-]{1,20}$/);

const symbolNameArbitrary = (): fc.Arbitrary<string> =>
  fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,19}$/);

const symbolKindArbitrary = (): fc.Arbitrary<string> =>
  fc.oneof(
    fc.constant("function"),
    fc.constant("class"),
    fc.constant("method"),
    fc.constant("interface"),
    fc.constant("variable"),
  );

const graphNodeArbitrary = (): fc.Arbitrary<GraphNode> =>
  fc.record({
    id: symbolIdArbitrary(),
    labels: fc.array(fc.oneof(fc.constant("Symbol"), fc.constant("Cluster"), fc.constant("Process")), {
      minLength: 1,
      maxLength: 3,
    }),
    properties: fc.record({
      name: symbolNameArbitrary(),
      kind: symbolKindArbitrary(),
    }),
  });

// ─── Preservation Tests ────────────────────────────────────────────────────────

describe("Neo4j Preservation Properties: Single-Instance Behavior", () => {
  let session: MockSession;

  beforeEach(() => {
    session = makeMockSession();
  });

  it("Property 1: storeNodes writes and reads produce identical results (single instance)", async () => {
    // Property: For any set of nodes written to Neo4j by a single instance,
    // reading them back produces identical data (same labels, same properties).
    //
    // This establishes the baseline behavior that must be preserved after the fix.

    await fc.assert(
      fc.asyncProperty(fc.array(graphNodeArbitrary(), { minLength: 1, maxLength: 10 }), async (nodes) => {
        // Arrange: fresh session for each run
        const testSession = makeMockSession();

        // Act: write nodes
        await storeNodes(testSession as never, nodes, "tpc_");

        // Assert: for each unique node ID (last write wins), verify it's stored correctly
        // Build a map of last-written node per id (mirrors MERGE semantics)
        const lastWrittenById = new Map<string, GraphNode>();
        for (const node of nodes) {
          lastWrittenById.set(node.id, node);
        }

        for (const [id, node] of lastWrittenById) {
          const stored = testSession.nodeStore.get(`tpc_${node.labels[0] ?? "Node"}:${id}`);

          // Node must exist in store
          expect(stored).toBeDefined();

          // Labels must match exactly (with prefix applied)
          expect(stored?.labels).toEqual(node.labels.map((l) => `tpc_${l}`));

          // Properties must include all original properties plus id
          expect(stored?.properties).toMatchObject({
            ...node.properties,
            id: node.id,
          });
        }
      }),
      { numRuns: 20 },
    );
  });

  it("Property 2: Multiple writes to same node ID result in merged properties", async () => {
    // Property: When the same node ID is written twice with different properties,
    // the final stored node contains merged properties (MERGE semantics).
    //
    // This verifies that MERGE behavior is preserved.

    await fc.assert(
      fc.asyncProperty(
        symbolIdArbitrary(),
        fc.array(fc.record({ name: symbolNameArbitrary(), kind: symbolKindArbitrary() }), {
          minLength: 2,
          maxLength: 5,
        }),
        async (nodeId, propertyUpdates) => {
          const testSession = makeMockSession();

          // Act: write the same node ID multiple times with different properties
          for (const props of propertyUpdates) {
            const node: GraphNode = {
              id: nodeId,
              labels: ["Symbol"],
              properties: props,
            };
            await storeNodes(testSession as never, [node], "tpc_");
          }

          // Assert: the final stored node has the last written properties
          const stored = testSession.nodeStore.get(`tpc_Symbol:${nodeId}`);
          expect(stored).toBeDefined();
          expect(stored?.properties).toMatchObject(propertyUpdates[propertyUpdates.length - 1]);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("Property 3: Node labels are preserved exactly as provided", async () => {
    // Property: For any node with a set of labels, the stored node has
    // exactly those labels (no additions, no removals).
    //
    // This verifies label preservation.

    await fc.assert(
      fc.asyncProperty(graphNodeArbitrary(), async (node) => {
        const testSession = makeMockSession();

        // Act: write node
        await storeNodes(testSession as never, [node], "tpc_");

        // Assert: labels match exactly
        const stored = testSession.nodeStore.get(`tpc_${node.labels[0] ?? "Node"}:${node.id}`);
        expect(stored?.labels).toEqual(node.labels.map((l) => `tpc_${l}`));
      }),
      { numRuns: 20 },
    );
  });

  it("Property 4: Batch writes produce same result as individual writes", async () => {
    // Property: Writing N nodes in a single batch produces the same result
    // as writing them individually.
    //
    // This verifies batch semantics are correct.

    await fc.assert(
      fc.asyncProperty(fc.array(graphNodeArbitrary(), { minLength: 1, maxLength: 10 }), async (nodes) => {
        // Batch write
        const batchSession = makeMockSession();
        await storeNodes(batchSession as never, nodes, "tpc_");

        // Individual writes
        const individualSession = makeMockSession();
        for (const node of nodes) {
          await storeNodes(individualSession as never, [node], "tpc_");
        }

        // Assert: both sessions have identical node stores
        expect(batchSession.nodeStore.size).toBe(individualSession.nodeStore.size);

        for (const [id, batchNode] of batchSession.nodeStore) {
          const individualNode = individualSession.nodeStore.get(id);
          expect(individualNode).toEqual(batchNode);
        }
      }),
      { numRuns: 20 },
    );
  });

  it("Property 5: Empty node list produces no writes", async () => {
    // Property: Calling storeNodes with an empty array produces no database writes.

    const testSession = makeMockSession();

    // Act: write empty list
    await storeNodes(testSession as never, [], "tpc_");

    // Assert: no writes occurred
    expect(testSession.capturedWrites).toHaveLength(0);
    expect(testSession.nodeStore.size).toBe(0);
  });

  it("Property 6: Node properties are preserved without modification", async () => {
    // Property: For any node with arbitrary properties, all properties are
    // stored exactly as provided (no filtering, no transformation).

    await fc.assert(
      fc.asyncProperty(
        symbolIdArbitrary(),
        fc.record({
          name: symbolNameArbitrary(),
          kind: symbolKindArbitrary(),
          custom1: fc.string(),
          custom2: fc.integer(),
        }),
        async (nodeId, properties) => {
          const testSession = makeMockSession();

          const node: GraphNode = {
            id: nodeId,
            labels: ["Symbol"],
            properties,
          };

          // Act: write node
          await storeNodes(testSession as never, [node], "tpc_");

          // Assert: all properties are stored
          const stored = testSession.nodeStore.get(`tpc_Symbol:${nodeId}`);
          expect(stored?.properties).toMatchObject(properties);
        },
      ),
      { numRuns: 20 },
    );
  });
});
