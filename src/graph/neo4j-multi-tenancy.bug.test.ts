/**
 * Bug condition exploration test: Neo4j multi-tenancy label collision.
 *
 * THIS TEST MUST FAIL ON UNFIXED CODE.
 * Failure confirms the bug: storeNodes() and storeEdges() in store.ts
 * use hardcoded unprefixed labels and relationship types, causing data
 * collisions when two instances with different prefixes share the same
 * Neo4j database.
 *
 * Bug condition C(X): instance1Prefix !== instance2Prefix AND sharedDb = true
 *
 * Requirements: 1.1, 1.2, 1.3
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { storeNodes } from "./store.js";
import type { GraphNode } from "./connection.js";

// ---------------------------------------------------------------------------
// Mock session factory — captures all Cypher strings written via executeWrite
// ---------------------------------------------------------------------------

interface CapturedWrite {
  cypher: string;
  params: Record<string, unknown>;
}

interface MockSession {
  executeWrite: ReturnType<typeof vi.fn>;
  executeRead: ReturnType<typeof vi.fn>;
  capturedWrites: CapturedWrite[];
  // Simulated in-memory node store keyed by id
  nodeStore: Map<string, { labels: string[]; properties: Record<string, string> }>;
}

function makeMockSession(): MockSession {
  const nodeStore = new Map<string, { labels: string[]; properties: Record<string, string> }>();
  const capturedWrites: CapturedWrite[] = [];

  const session: MockSession = {
    capturedWrites,
    nodeStore,
    executeWrite: vi.fn().mockImplementation(
      async (fn: (tx: { run: (cypher: string, params?: Record<string, unknown>) => Promise<{ records: unknown[] }> }) => Promise<unknown>) => {
        const mockTx = {
          run: vi.fn().mockImplementation(async (cypher: string, params: Record<string, unknown> = {}) => {
            capturedWrites.push({ cypher, params });

            // Simulate MERGE (x:<label> {id: $id}) SET x += $props
            // This is the fallback path in storeNodes when APOC is unavailable
            const mergeMatch = /MERGE \(x:(\S+) \{id: \$id\}\) SET x \+= \$props/.exec(cypher);
            if (mergeMatch) {
              const label = mergeMatch[1] as string;
              const id = params["id"] as string;
              const props = params["props"] as Record<string, string>;
              // Use composite key label:id to simulate Neo4j's label-scoped node storage
              nodeStore.set(`${label}:${id}`, { labels: [label], properties: { ...props, id } });
            }

            // Simulate UNWIND $nodes AS n ... apoc.merge.node(n.labels, {id: n.id}, n.properties)
            // Treat as a batch MERGE using the first label
            const apocMatch = /UNWIND \$nodes AS n/.exec(cypher);
            if (apocMatch) {
              const nodes = params["nodes"] as Array<{ id: string; labels: string[]; properties: Record<string, string> }>;
              for (const n of nodes) {
                // Use composite key label:id to simulate Neo4j's label-scoped node storage
                const primaryLabel = n.labels[0] ?? "Node";
                nodeStore.set(`${primaryLabel}:${n.id}`, { labels: n.labels, properties: { ...n.properties, id: n.id } });
              }
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

// ---------------------------------------------------------------------------
// Helper: build a Symbol GraphNode
// ---------------------------------------------------------------------------

function makeSymbolNode(id: string, name: string, extra: Record<string, string> = {}): GraphNode {
  return {
    id,
    labels: ["Symbol"],
    properties: { name, kind: "function", ...extra },
  };
}

// ---------------------------------------------------------------------------
// Bug condition exploration tests
// ---------------------------------------------------------------------------

describe("Neo4j bug condition: label collision across instances (MUST FAIL on unfixed code)", () => {
  let sharedSession: MockSession;

  beforeEach(() => {
    // Both instances share the same Neo4j session (same database)
    sharedSession = makeMockSession();
  });

  it("instance 1 reads instance 2's node after both write the same symbol ID without prefix isolation", async () => {
    // Arrange — two instances with different prefixes, same shared DB
    const instance1Prefix = "tpc_";
    const instance2Prefix = "myapp_";
    const sharedSymbolId = "sym-foo";

    const instance1Node = makeSymbolNode(sharedSymbolId, "foo", { owner: "instance1" });
    const instance2Node = makeSymbolNode(sharedSymbolId, "foo", { owner: "instance2" });

    // Act — instance 1 indexes its symbol
    await storeNodes(sharedSession as never, [instance1Node], instance1Prefix);

    // Act — instance 2 indexes the same symbol ID with different properties
    // (simulates a second Typocop instance with prefix "myapp_" writing to the same DB)
    await storeNodes(sharedSession as never, [instance2Node], instance2Prefix);

    // Assert — the node store should contain isolated entries per prefix.
    // After the fix, each instance writes to its own prefixed label
    // (tpc_Symbol vs myapp_Symbol), so they are stored under different composite keys
    // and this collision cannot occur.
    const storedNode = sharedSession.nodeStore.get(`tpc_Symbol:${sharedSymbolId}`);

    // This assertion PASSES after the fix because instance 1's node is stored
    // under "tpc_Symbol:sym-foo" and instance 2's under "myapp_Symbol:sym-foo".
    expect(storedNode?.properties["owner"]).toBe("instance1");
  });

  it("Cypher written by storeNodes uses prefixed labels, not hardcoded 'Symbol'", async () => {
    // Arrange
    const node = makeSymbolNode("sym-bar", "bar");

    // Act — call storeNodes (the buggy path used by the pipeline)
    await storeNodes(sharedSession as never, [node], "tpc_");

    // Assert — every Cypher statement must reference a prefixed label.
    // On UNFIXED code, the Cypher contains the bare "Symbol" label.
    // After the fix, it must contain a prefixed label like "tpc_Symbol".
    const allCypher = sharedSession.capturedWrites.map((w) => w.cypher).join("\n");

    // This assertion FAILS on unfixed code because storeNodes emits "Symbol"
    // without any prefix.
    expect(allCypher).not.toContain(":Symbol");
  });

  it("two instances with different prefixes produce isolated node entries in the shared store", async () => {
    // Arrange
    const symbolId = "sym-shared";
    const instance1Node = makeSymbolNode(symbolId, "sharedFn", { source: "tpc" });
    const instance2Node = makeSymbolNode(symbolId, "sharedFn", { source: "myapp" });

    // Act — both instances write to the shared session
    await storeNodes(sharedSession as never, [instance1Node], "tpc_");
    await storeNodes(sharedSession as never, [instance2Node], "myapp_");

    // Assert — after the fix, the node store must contain TWO separate entries
    // (one per prefixed label), so the map size must be >= 2 for this symbol.
    // After the fix, both writes target different composite keys.
    //
    // We check that instance 1's entry is still intact under its prefixed key.
    const entry = sharedSession.nodeStore.get(`tpc_Symbol:${symbolId}`);

    // PASSES after fix: instance 1's entry is stored under "tpc_Symbol:sym-shared"
    // and instance 2's under "myapp_Symbol:sym-shared" — no collision.
    expect(entry?.properties["source"]).toBe("tpc");
  });
});
