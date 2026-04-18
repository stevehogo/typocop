/**
 * Unit tests for vector store operations: indexSymbol, clearVectorData.
 * Requirements: 3.7, 17.1, 17.5
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { clearVectorData } from "./index-store.js";
import type { Pool } from "pg";

function makeMockPool() {
  return {
    connect: vi.fn().mockResolvedValue({
      query: vi.fn(),
      release: vi.fn(),
    }),
  };
}

describe("clearVectorData", () => {
  let mockPool: ReturnType<typeof makeMockPool>;
  let mockClient: ReturnType<ReturnType<typeof makeMockPool>["connect"]>;

  beforeEach(() => {
    mockPool = makeMockPool();
    mockClient = {
      query: vi.fn(),
      release: vi.fn(),
    };
    (mockPool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);
    vi.clearAllMocks();
  });

  it("should delete all embeddings for the prefix", async () => {
    (mockClient.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 5 });

    await clearVectorData(mockPool as never, "tpc_");

    expect(mockPool.connect).toHaveBeenCalledTimes(1);
    expect(mockClient.query).toHaveBeenCalledWith(
      `DELETE FROM tpc_embeddings
       WHERE symbol_id LIKE $1`,
      ["tpc_%"],
    );
  });

  it("should log deletion count", async () => {
    (mockClient.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 10 });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await clearVectorData(mockPool as never, "tpc_");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[clearVectorData] Deleted 10 embeddings with prefix "tpc_"',
    );

    consoleErrorSpy.mockRestore();
  });

  it("should be idempotent (safe to call multiple times)", async () => {
    (mockClient.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 0 });

    // First call
    await clearVectorData(mockPool as never, "tpc_");
    // Second call
    await clearVectorData(mockPool as never, "tpc_");

    expect(mockPool.connect).toHaveBeenCalledTimes(2);
    expect(mockClient.query).toHaveBeenCalledTimes(2);
  });

  it("should handle errors gracefully and propagate them", async () => {
    const testError = new Error("PostgreSQL connection failed");
    (mockClient.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(testError);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(clearVectorData(mockPool as never, "tpc_")).rejects.toThrow(
      "PostgreSQL connection failed",
    );

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[clearVectorData] Error clearing vector data for prefix "tpc_": PostgreSQL connection failed',
    );

    consoleErrorSpy.mockRestore();
  });

  it("should handle non-Error exceptions", async () => {
    (mockClient.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce("string error");
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(clearVectorData(mockPool as never, "tpc_")).rejects.toBe("string error");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[clearVectorData] Error clearing vector data for prefix "tpc_": string error',
    );

    consoleErrorSpy.mockRestore();
  });

  it("should properly release database connection", async () => {
    (mockClient.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 5 });

    await clearVectorData(mockPool as never, "tpc_");

    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it("should release connection even on error", async () => {
    (mockClient.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("query failed"),
    );

    await expect(clearVectorData(mockPool as never, "tpc_")).rejects.toThrow("query failed");

    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it("should handle empty result sets (no data to delete)", async () => {
    (mockClient.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 0 });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await clearVectorData(mockPool as never, "tpc_");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[clearVectorData] Deleted 0 embeddings with prefix "tpc_"',
    );

    consoleErrorSpy.mockRestore();
  });

  it("should use different prefixes correctly", async () => {
    (mockClient.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 3 });

    await clearVectorData(mockPool as never, "myapp_");

    expect(mockClient.query).toHaveBeenCalledWith(
      `DELETE FROM myapp_embeddings
       WHERE symbol_id LIKE $1`,
      ["myapp_%"],
    );
  });

  it("should handle null rowCount", async () => {
    (mockClient.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: null });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await clearVectorData(mockPool as never, "tpc_");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[clearVectorData] Deleted 0 embeddings with prefix "tpc_"',
    );

    consoleErrorSpy.mockRestore();
  });

  it("should preserve embeddings for other prefixes", async () => {
    (mockClient.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 5 });

    // Delete embeddings for "tpc_" prefix
    await clearVectorData(mockPool as never, "tpc_");

    // Verify the query uses LIKE with the specific prefix pattern
    expect(mockClient.query).toHaveBeenCalledWith(
      `DELETE FROM tpc_embeddings
       WHERE symbol_id LIKE $1`,
      ["tpc_%"],
    );

    // The query only deletes rows where symbol_id starts with "tpc_"
    // Embeddings with other prefixes (e.g., "app_", "lib_") are not affected
    // because they don't match the LIKE pattern "tpc_%"
  });
});
