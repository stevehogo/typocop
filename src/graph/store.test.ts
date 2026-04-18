/**
 * Unit tests for graph store operations: storeNodes, storeEdges, clearGraphData.
 * Requirements: 3.7, 16.1, 16.2, 16.3
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { clearGraphData } from "./store.js";
import type { Session } from "neo4j-driver";

function makeMockSession() {
  return {
    executeWrite: vi.fn().mockImplementation(async (fn: (tx: { run: ReturnType<typeof vi.fn> }) => Promise<unknown>) =>
      fn({ run: vi.fn().mockResolvedValue({ records: [] }) }),
    ),
  };
}

describe("clearGraphData", () => {
  let mockSession: ReturnType<typeof makeMockSession>;

  beforeEach(() => {
    mockSession = makeMockSession();
    vi.clearAllMocks();
  });

  it("should delete all relationships with prefixed types", async () => {
    const mockTx = { run: vi.fn().mockResolvedValue({ records: [{ get: vi.fn().mockReturnValue(5) }] }) };
    mockSession.executeWrite.mockImplementation(async (fn) => fn(mockTx));

    await clearGraphData(mockSession as never, "tpc_");

    expect(mockSession.executeWrite).toHaveBeenCalledTimes(2);
    const firstCall = mockTx.run.mock.calls[0];
    expect(firstCall[0]).toContain("DELETE r");
    expect(firstCall[0]).toContain("type(r) STARTS WITH");
    expect(firstCall[1]).toEqual({ prefix: "tpc_" });
  });

  it("should delete all nodes with prefixed labels", async () => {
    const mockTx = { run: vi.fn().mockResolvedValue({ records: [{ get: vi.fn().mockReturnValue(10) }] }) };
    mockSession.executeWrite.mockImplementation(async (fn) => fn(mockTx));

    await clearGraphData(mockSession as never, "tpc_");

    expect(mockSession.executeWrite).toHaveBeenCalledTimes(2);
    const secondCall = mockTx.run.mock.calls[1];
    expect(secondCall[0]).toContain("DETACH DELETE n");
    expect(secondCall[0]).toContain("label STARTS WITH");
    expect(secondCall[1]).toEqual({ prefix: "tpc_" });
  });

  it("should log deletion counts", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mockTx = {
      run: vi
        .fn()
        .mockResolvedValueOnce({ records: [{ get: vi.fn().mockReturnValue(5) }] })
        .mockResolvedValueOnce({ records: [{ get: vi.fn().mockReturnValue(10) }] }),
    };
    mockSession.executeWrite.mockImplementation(async (fn) => fn(mockTx));

    await clearGraphData(mockSession as never, "tpc_");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[clearGraphData] Deleted 5 relationships and 10 nodes with prefix "tpc_"'
    );

    consoleErrorSpy.mockRestore();
  });

  it("should be idempotent (safe to call multiple times)", async () => {
    const mockTx = { run: vi.fn().mockResolvedValue({ records: [{ get: vi.fn().mockReturnValue(0) }] }) };
    mockSession.executeWrite.mockImplementation(async (fn) => fn(mockTx));

    // First call
    await clearGraphData(mockSession as never, "tpc_");
    // Second call
    await clearGraphData(mockSession as never, "tpc_");

    expect(mockSession.executeWrite).toHaveBeenCalledTimes(4);
  });

  it("should handle errors gracefully and propagate them", async () => {
    const testError = new Error("Neo4j connection failed");
    mockSession.executeWrite.mockRejectedValueOnce(testError);

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(clearGraphData(mockSession as never, "tpc_")).rejects.toThrow("Neo4j connection failed");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[clearGraphData] Error clearing graph data for prefix "tpc_": Neo4j connection failed'
    );

    consoleErrorSpy.mockRestore();
  });

  it("should handle non-Error exceptions", async () => {
    mockSession.executeWrite.mockRejectedValueOnce("string error");

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(clearGraphData(mockSession as never, "tpc_")).rejects.toBe("string error");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[clearGraphData] Error clearing graph data for prefix "tpc_": string error'
    );

    consoleErrorSpy.mockRestore();
  });

  it("should handle empty result sets (no data to delete)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mockTx = { run: vi.fn().mockResolvedValue({ records: [] }) };
    mockSession.executeWrite.mockImplementation(async (fn) => fn(mockTx));

    await clearGraphData(mockSession as never, "tpc_");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[clearGraphData] Deleted 0 relationships and 0 nodes with prefix "tpc_"'
    );

    consoleErrorSpy.mockRestore();
  });

  it("should use different prefixes correctly", async () => {
    const mockTx = { run: vi.fn().mockResolvedValue({ records: [{ get: vi.fn().mockReturnValue(0) }] }) };
    mockSession.executeWrite.mockImplementation(async (fn) => fn(mockTx));

    await clearGraphData(mockSession as never, "myapp_");

    const firstCall = mockTx.run.mock.calls[0];
    expect(firstCall[1]).toEqual({ prefix: "myapp_" });
  });

  it("should preserve non-prefixed data by only deleting prefixed relationships and nodes", async () => {
    const mockTx = { run: vi.fn().mockResolvedValue({ records: [{ get: vi.fn().mockReturnValue(0) }] }) };
    mockSession.executeWrite.mockImplementation(async (fn) => fn(mockTx));

    await clearGraphData(mockSession as never, "tpc_");

    // Verify that the relationship deletion query filters by prefix
    const relQuery = mockTx.run.mock.calls[0][0];
    expect(relQuery).toContain("type(r) STARTS WITH");
    expect(relQuery).toContain("WHERE");

    // Verify that the node deletion query filters by prefix
    const nodeQuery = mockTx.run.mock.calls[1][0];
    expect(nodeQuery).toContain("label STARTS WITH");
    expect(nodeQuery).toContain("WHERE");
    expect(nodeQuery).toContain("any(label IN labels(n)");

    // Both queries should use the prefix parameter to filter
    expect(mockTx.run.mock.calls[0][1]).toEqual({ prefix: "tpc_" });
    expect(mockTx.run.mock.calls[1][1]).toEqual({ prefix: "tpc_" });
  });
});
