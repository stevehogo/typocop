/**
 * Wave 8 · T4 — route enumeration (findRoutes) tests.
 *
 * Query-aware mock GraphAdapter that answers the single HANDLES_ROUTE query
 * shape findRoutes issues; the fixture supplies the linked (handler, endpoint)
 * pairs as projected rows.
 */
import { describe, it, expect } from "vitest";
import type { GraphAdapter } from "../../core/ports/persistence.js";
import { findRoutes } from "./route-map.js";

interface RouteFixture {
  endpointId: string;
  endpointName: string;
  handlerId: string;
  handlerName: string;
  handlerFilePath?: string;
  confidence?: string;
  reason?: string;
}

function makeGraph(routes: RouteFixture[]): GraphAdapter {
  const runCypher = async <T,>(query: string): Promise<T[]> => {
    if (query.includes("HANDLES_ROUTE")) {
      return routes.map((r) => ({
        endpointId: r.endpointId,
        endpointName: r.endpointName,
        handlerId: r.handlerId,
        handlerName: r.handlerName,
        handlerFilePath: r.handlerFilePath ?? "/repo/handler.ts",
        confidence: r.confidence ?? null,
        reason: r.reason ?? null,
      })) as unknown as T[];
    }
    return [] as T[];
  };
  return {
    createNode: async () => {},
    createRelationship: async () => {},
    queryNodes: async () => [],
    queryRelationships: async () => [],
    deleteNodesByLabel: async () => 0,
    deleteRelationshipsByType: async () => 0,
    runCypher: runCypher as GraphAdapter["runCypher"],
    runCypherWrite: async () => {},
  };
}

describe("findRoutes", () => {
  it("enumerates linked routes with confidence + reason", async () => {
    const graph = makeGraph([
      {
        endpointId: "apiendpoint:GET:/users",
        endpointName: "GET /users",
        handlerId: "h1",
        handlerName: "listUsers",
        confidence: "0.85",
        reason: "decorator-Get",
      },
      {
        endpointId: "apiendpoint:POST:/users",
        endpointName: "POST /users",
        handlerId: "h2",
        handlerName: "createUser",
      },
    ]);
    const result = await findRoutes(graph);
    expect(result.totalFound).toBe(2);
    expect(result.routes[0]).toMatchObject({
      endpointId: "apiendpoint:GET:/users",
      endpointName: "GET /users",
      handlerName: "listUsers",
      confidence: 0.85,
      reason: "decorator-Get",
    });
    // No confidence/reason → those keys omitted (not null/0).
    expect(result.routes[1].confidence).toBeUndefined();
    expect(result.routes[1].reason).toBeUndefined();
  });

  it("degrades to an empty result when no HANDLES_ROUTE edges exist", async () => {
    const graph = makeGraph([]);
    const result = await findRoutes(graph);
    expect(result.routes).toHaveLength(0);
    expect(result.totalFound).toBe(0);
  });

  it("caps at maxResults but reports totalFound", async () => {
    const graph = makeGraph(
      Array.from({ length: 5 }, (_, i) => ({
        endpointId: `apiendpoint:GET:/r${i}`,
        endpointName: `GET /r${i}`,
        handlerId: `h${i}`,
        handlerName: `handler${i}`,
      })),
    );
    const result = await findRoutes(graph, { maxResults: 2 });
    expect(result.routes).toHaveLength(2);
    expect(result.totalFound).toBe(5);
  });

  it("skips rows missing an endpoint or handler id", async () => {
    const graph = makeGraph([
      { endpointId: "", endpointName: "bad", handlerId: "h1", handlerName: "x" },
    ]);
    const result = await findRoutes(graph);
    expect(result.routes).toHaveLength(0);
  });
});
