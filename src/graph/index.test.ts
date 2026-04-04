/**
 * Property tests for graph database interface.
 *
 * Property 18: Graph Traversal Depth Limit
 *   Cypher queries generated for traversal must embed MAX_TRAVERSAL_DEPTH
 *   so Neo4j never follows more hops than the limit.
 *   Validates: Requirement 16.7, 23.4
 *
 * Note: These tests verify the query construction logic without a live Neo4j
 * instance by mocking the Session. Integration tests with a real DB live in
 * tests/integration/.
 */
import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import { MAX_TRAVERSAL_DEPTH } from "../utils/limits.js";
import { withRetry } from "./connection.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a mock Session that captures the last Cypher query run. */
function mockSession(returnRecords: unknown[] = []) {
  const calls: string[] = [];
  const session = {
    run: vi.fn(async (query: string) => {
      calls.push(query);
      return { records: returnRecords };
    }),
    _calls: calls,
  };
  return session;
}

// ─── Property 18: Depth limit embedded in queries ────────────────────────────

describe("Graph traversal depth limit (Property 18)", () => {
  it("findDependents query contains MAX_TRAVERSAL_DEPTH", async () => {
    // Import lazily so vi.mock can intercept neo4j-driver if needed
    const { findDependents } = await import("./query.js");
    const session = mockSession();
    await findDependents(session as never, "sym-1");
    const query = session._calls[0] ?? "";
    expect(query).toContain(`${MAX_TRAVERSAL_DEPTH}`);
  });

  it("findDependencies query contains MAX_TRAVERSAL_DEPTH", async () => {
    const { findDependencies } = await import("./query.js");
    const session = mockSession();
    await findDependencies(session as never, "sym-1");
    const query = session._calls[0] ?? "";
    expect(query).toContain(`${MAX_TRAVERSAL_DEPTH}`);
  });

  it("traversePath query contains MAX_TRAVERSAL_DEPTH", async () => {
    const { traversePath } = await import("./query.js");
    const session = mockSession([{ get: () => [] }]);
    await traversePath(session as never, "a", "b");
    const query = session._calls[0] ?? "";
    expect(query).toContain(`${MAX_TRAVERSAL_DEPTH}`);
  });

  it("Property 18: depth limit is always present regardless of symbol ID", async () => {
    const { findDependents } = await import("./query.js");
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1 }), async (symbolId) => {
        const calls: string[] = [];
        const session = {
          run: vi.fn(async (query: string) => { calls.push(query); return { records: [] }; }),
        };
        await findDependents(session as never, symbolId);
        return (calls[0] ?? "").includes(`${MAX_TRAVERSAL_DEPTH}`);
      }),
    );
  });
});

// ─── withRetry ────────────────────────────────────────────────────────────────

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const result = await withRetry(async () => 42);
    expect(result).toBe(42);
  });

  it("retries on failure and succeeds on second attempt", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 2) throw new Error("transient");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("throws after maxAttempts failures", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error("always fails");
      }, 3),
    ).rejects.toThrow("always fails");
    expect(calls).toBe(3);
  });
});
