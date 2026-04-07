/**
 * Property-based tests for GraphStore Neo4j prefixing.
 * Validates: Requirements 4.1, 4.2, 5.1, 5.2
 */
import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import { GraphStore } from "./graph-store.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type MockTx = { run: ReturnType<typeof vi.fn> };
type MockSession = {
  executeWrite: ReturnType<typeof vi.fn>;
  executeRead: ReturnType<typeof vi.fn>;
};

function makeMockSession(): MockSession {
  return {
    executeWrite: vi.fn().mockImplementation(async (fn: (tx: MockTx) => Promise<unknown>) =>
      fn({ run: vi.fn().mockResolvedValue({ records: [] }) }),
    ),
    executeRead: vi.fn().mockImplementation(async (fn: (tx: MockTx) => Promise<unknown>) =>
      fn({ run: vi.fn().mockResolvedValue({ records: [] }) }),
    ),
  };
}

/** Extract the Cypher string passed to tx.run from a captured executeWrite/executeRead call. */
async function captureWriteCypher(session: MockSession): Promise<string> {
  const txFn = session.executeWrite.mock.calls[0][0] as (tx: MockTx) => Promise<unknown>;
  const mockTx: MockTx = { run: vi.fn().mockResolvedValue({ records: [] }) };
  await txFn(mockTx);
  return mockTx.run.mock.calls[0][0] as string;
}

async function captureReadCypher(session: MockSession): Promise<string> {
  const txFn = session.executeRead.mock.calls[0][0] as (tx: MockTx) => Promise<unknown>;
  const mockTx: MockTx = { run: vi.fn().mockResolvedValue({ records: [] }) };
  await txFn(mockTx);
  return mockTx.run.mock.calls[0][0] as string;
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/** Valid normalized prefix: starts with [a-z], contains [a-z0-9_], ends with _, max 32 chars. */
const validPrefixArb = fc.stringMatching(/^[a-z][a-z0-9_]{0,29}_$/);

const baseLabelArb = fc.constantFrom(
  "Symbol" as const,
  "File" as const,
  "Cluster" as const,
  "Process" as const,
  "Metadata" as const,
);

const baseRelTypeArb = fc.constantFrom(
  "CALLS" as const,
  "IMPORTS" as const,
  "INHERITS" as const,
  "IMPLEMENTS" as const,
  "CONTAINS" as const,
  "REFERENCES" as const,
  "DEFINES" as const,
);

// ─── Property 4: Node Label Construction ──────────────────────────────────────

describe("Property 4: Node Label Construction", () => {
  /**
   * For any valid prefix and base node label, the GraphStore SHALL construct
   * the final label as prefix + label.
   * Validates: Requirements 4.1, 4.2
   */
  it("getLabel returns prefix + base for any valid prefix and base label", () => {
    fc.assert(
      fc.property(validPrefixArb, baseLabelArb, (prefix, base) => {
        const store = new GraphStore(prefix);
        expect(store.getLabel(base)).toBe(`${prefix}${base}`);
      }),
      { numRuns: 100 },
    );
  });

  it("getLabel result starts with the prefix", () => {
    fc.assert(
      fc.property(validPrefixArb, baseLabelArb, (prefix, base) => {
        const store = new GraphStore(prefix);
        expect(store.getLabel(base)).toMatch(new RegExp(`^${prefix}`));
      }),
      { numRuns: 100 },
    );
  });

  it("getLabel result ends with the base label", () => {
    fc.assert(
      fc.property(validPrefixArb, baseLabelArb, (prefix, base) => {
        const store = new GraphStore(prefix);
        expect(store.getLabel(base)).toMatch(new RegExp(`${base}$`));
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 5: Relationship Type Construction ───────────────────────────────

describe("Property 5: Relationship Type Construction", () => {
  /**
   * For any valid prefix and base relationship type, the GraphStore SHALL
   * construct the final type as prefix + type.
   * Validates: Requirements 5.1, 5.2
   */
  it("getRelationType returns prefix + base for any valid prefix and base type", () => {
    fc.assert(
      fc.property(validPrefixArb, baseRelTypeArb, (prefix, base) => {
        const store = new GraphStore(prefix);
        expect(store.getRelationType(base)).toBe(`${prefix}${base}`);
      }),
      { numRuns: 100 },
    );
  });

  it("getRelationType result starts with the prefix", () => {
    fc.assert(
      fc.property(validPrefixArb, baseRelTypeArb, (prefix, base) => {
        const store = new GraphStore(prefix);
        expect(store.getRelationType(base)).toMatch(new RegExp(`^${prefix}`));
      }),
      { numRuns: 100 },
    );
  });

  it("getRelationType result ends with the base type", () => {
    fc.assert(
      fc.property(validPrefixArb, baseRelTypeArb, (prefix, base) => {
        const store = new GraphStore(prefix);
        expect(store.getRelationType(base)).toMatch(new RegExp(`${base}$`));
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 9: Query Prefix Consistency ─────────────────────────────────────

describe("Property 9: Query Prefix Consistency (Neo4j)", () => {
  /**
   * For any valid prefix, all Cypher queries constructed by GraphStore SHALL
   * consistently use the prefixed label/type.
   * Validates: Requirements 4.2, 5.2
   */
  it("createNode Cypher contains prefixed label for any valid prefix", async () => {
    await fc.assert(
      fc.asyncProperty(validPrefixArb, baseLabelArb, async (prefix, label) => {
        const session = makeMockSession();
        const store = new GraphStore(prefix);
        await store.createNode(session as never, label, { id: "test-id" });

        const cypher = await captureWriteCypher(session);
        expect(cypher).toContain(`${prefix}${label}`);
      }),
      { numRuns: 50 },
    );
  });

  it("createRelationship Cypher contains prefixed type for any valid prefix", async () => {
    await fc.assert(
      fc.asyncProperty(validPrefixArb, baseRelTypeArb, async (prefix, relType) => {
        const session = makeMockSession();
        const store = new GraphStore(prefix);
        await store.createRelationship(session as never, "a", "b", relType);

        const cypher = await captureWriteCypher(session);
        expect(cypher).toContain(`${prefix}${relType}`);
      }),
      { numRuns: 50 },
    );
  });

  it("queryNodes Cypher contains prefixed label for any valid prefix", async () => {
    await fc.assert(
      fc.asyncProperty(validPrefixArb, baseLabelArb, async (prefix, label) => {
        const session = makeMockSession();
        const store = new GraphStore(prefix);
        await store.queryNodes(session as never, label);

        const cypher = await captureReadCypher(session);
        expect(cypher).toContain(`${prefix}${label}`);
      }),
      { numRuns: 50 },
    );
  });
});

// ─── 8.3 Integration test: tpc_-prefixed nodes and relationships ───────────────

describe("Integration: tpc_-prefixed nodes and relationships", () => {
  it("createNode with label 'Symbol' uses tpc_Symbol in Cypher", async () => {
    const session = makeMockSession();
    const store = new GraphStore("tpc_");
    await store.createNode(session as never, "Symbol", { id: "sym-1", name: "foo" });

    const cypher = await captureWriteCypher(session);
    expect(cypher).toContain("tpc_Symbol");
  });

  it("createRelationship with type 'CALLS' uses tpc_CALLS in Cypher", async () => {
    const session = makeMockSession();
    const store = new GraphStore("tpc_");
    await store.createRelationship(session as never, "sym-1", "sym-2", "CALLS");

    const cypher = await captureWriteCypher(session);
    expect(cypher).toContain("tpc_CALLS");
  });

  it("queryNodes with label 'File' uses tpc_File in Cypher", async () => {
    const session = makeMockSession();
    const store = new GraphStore("tpc_");
    await store.queryNodes(session as never, "File");

    const cypher = await captureReadCypher(session);
    expect(cypher).toContain("tpc_File");
  });

  it("deleteNodesByLabel with label 'Cluster' uses tpc_Cluster in Cypher", async () => {
    const session = makeMockSession();
    const store = new GraphStore("tpc_");
    await store.deleteNodesByLabel(session as never, "Cluster");

    const cypher = await captureWriteCypher(session);
    expect(cypher).toContain("tpc_Cluster");
  });
});
