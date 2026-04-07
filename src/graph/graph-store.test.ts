/**
 * Unit tests for GraphStore — node label prefix support.
 * Requirements: 4.1–4.6
 */
import { describe, it, expect, vi } from "vitest";
import { GraphStore } from "./graph-store.js";

function makeMockSession() {
  return {
    executeWrite: vi.fn().mockImplementation(async (fn: (tx: { run: ReturnType<typeof vi.fn> }) => Promise<unknown>) =>
      fn({ run: vi.fn().mockResolvedValue({ records: [] }) }),
    ),
    executeRead: vi.fn().mockImplementation(async (fn: (tx: { run: ReturnType<typeof vi.fn> }) => Promise<unknown>) =>
      fn({ run: vi.fn().mockResolvedValue({ records: [] }) }),
    ),
  };
}

describe("GraphStore.getLabel", () => {
  it("prepends prefix to base label", () => {
    const store = new GraphStore("tpc_");
    expect(store.getLabel("Symbol")).toBe("tpc_Symbol");
  });

  it("prepends a different prefix", () => {
    const store = new GraphStore("myapp_");
    expect(store.getLabel("File")).toBe("myapp_File");
  });

  it("returns base label unchanged when prefix is empty", () => {
    const store = new GraphStore("");
    expect(store.getLabel("Symbol")).toBe("Symbol");
  });
});

describe("GraphStore.getRelationType", () => {
  it("prepends prefix to base relationship type", () => {
    const store = new GraphStore("tpc_");
    expect(store.getRelationType("CALLS")).toBe("tpc_CALLS");
  });

  it("prepends a different prefix to IMPORTS", () => {
    const store = new GraphStore("myapp_");
    expect(store.getRelationType("IMPORTS")).toBe("myapp_IMPORTS");
  });

  it("returns base type unchanged when prefix is empty", () => {
    const store = new GraphStore("");
    expect(store.getRelationType("CALLS")).toBe("CALLS");
  });
});

describe("GraphStore.createNode", () => {
  it("uses prefixed label in MERGE statement", async () => {
    const store = new GraphStore("tpc_");
    const mockSession = makeMockSession();

    await store.createNode(mockSession as never, "Symbol", { id: "sym-1", name: "foo" });

    expect(mockSession.executeWrite).toHaveBeenCalledOnce();
    const txFn = mockSession.executeWrite.mock.calls[0][0] as (tx: { run: ReturnType<typeof vi.fn> }) => Promise<unknown>;
    const mockTx = { run: vi.fn().mockResolvedValue({ records: [] }) };
    await txFn(mockTx);

    const cypher: string = mockTx.run.mock.calls[0][0] as string;
    expect(cypher).toContain("tpc_Symbol");
    expect(cypher).toContain("MERGE");
  });
});

describe("GraphStore.queryNodes", () => {
  it("uses prefixed label in MATCH statement", async () => {
    const store = new GraphStore("tpc_");
    const mockSession = makeMockSession();

    await store.queryNodes(mockSession as never, "File");

    expect(mockSession.executeRead).toHaveBeenCalledOnce();
    const txFn = mockSession.executeRead.mock.calls[0][0] as (tx: { run: ReturnType<typeof vi.fn> }) => Promise<unknown>;
    const mockTx = { run: vi.fn().mockResolvedValue({ records: [] }) };
    await txFn(mockTx);

    const cypher: string = mockTx.run.mock.calls[0][0] as string;
    expect(cypher).toContain("tpc_File");
    expect(cypher).toContain("MATCH");
  });
});

describe("GraphStore.deleteNodesByLabel", () => {
  it("uses prefixed label in DETACH DELETE statement", async () => {
    const store = new GraphStore("tpc_");
    const mockSession = makeMockSession();

    await store.deleteNodesByLabel(mockSession as never, "Cluster");

    expect(mockSession.executeWrite).toHaveBeenCalledOnce();
    const txFn = mockSession.executeWrite.mock.calls[0][0] as (tx: { run: ReturnType<typeof vi.fn> }) => Promise<unknown>;
    const mockTx = { run: vi.fn().mockResolvedValue({ records: [] }) };
    await txFn(mockTx);

    const cypher: string = mockTx.run.mock.calls[0][0] as string;
    expect(cypher).toContain("tpc_Cluster");
    expect(cypher).toContain("DETACH DELETE");
  });
});

describe("GraphStore.createRelationship", () => {
  it("uses prefixed type in MERGE statement", async () => {
    const store = new GraphStore("tpc_");
    const mockSession = makeMockSession();

    await store.createRelationship(mockSession as never, "sym-1", "sym-2", "CALLS");

    expect(mockSession.executeWrite).toHaveBeenCalledOnce();
    const txFn = mockSession.executeWrite.mock.calls[0][0] as (tx: { run: ReturnType<typeof vi.fn> }) => Promise<unknown>;
    const mockTx = { run: vi.fn().mockResolvedValue({ records: [] }) };
    await txFn(mockTx);

    const cypher: string = mockTx.run.mock.calls[0][0] as string;
    expect(cypher).toContain("tpc_CALLS");
    expect(cypher).toContain("MERGE");
  });
});

describe("GraphStore.queryRelationships", () => {
  it("uses prefixed type in MATCH statement", async () => {
    const store = new GraphStore("tpc_");
    const mockSession = makeMockSession();

    await store.queryRelationships(mockSession as never, "IMPORTS");

    expect(mockSession.executeRead).toHaveBeenCalledOnce();
    const txFn = mockSession.executeRead.mock.calls[0][0] as (tx: { run: ReturnType<typeof vi.fn> }) => Promise<unknown>;
    const mockTx = { run: vi.fn().mockResolvedValue({ records: [] }) };
    await txFn(mockTx);

    const cypher: string = mockTx.run.mock.calls[0][0] as string;
    expect(cypher).toContain("tpc_IMPORTS");
    expect(cypher).toContain("MATCH");
  });
});

describe("GraphStore.deleteRelationshipsByType", () => {
  it("uses prefixed type in DELETE statement", async () => {
    const store = new GraphStore("tpc_");
    const mockSession = makeMockSession();

    await store.deleteRelationshipsByType(mockSession as never, "CALLS");

    expect(mockSession.executeWrite).toHaveBeenCalledOnce();
    const txFn = mockSession.executeWrite.mock.calls[0][0] as (tx: { run: ReturnType<typeof vi.fn> }) => Promise<unknown>;
    const mockTx = { run: vi.fn().mockResolvedValue({ records: [] }) };
    await txFn(mockTx);

    const cypher: string = mockTx.run.mock.calls[0][0] as string;
    expect(cypher).toContain("tpc_CALLS");
    expect(cypher).toContain("DELETE");
  });
});
