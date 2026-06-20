/**
 * E3 — pure `shapeCheck` engine. A consumer reading a key no route returns is a
 * MISMATCH; confidence downgrades to `low` when the consumer fetches multiple
 * routes (R9). The KEY scenario: a route returning {data,page}, a consumer that
 * reads result.data (OK) + result.total (MISMATCH on total).
 */
import { describe, it, expect } from "vitest";
import { shapeCheck, type RouteShape, type ConsumerShape } from "./shape-check.js";

const route = (responseKeys: string[]): RouteShape => ({
  symbolId: "express:route:get:/users",
  name: "GET /users",
  filePath: "/repo/routes.ts",
  responseKeys,
});

const consumer = (accessedKeys: string[], routesFetchedInFile = 1): ConsumerShape => ({
  symbolId: "consumer#1",
  name: "renderUsers",
  filePath: "/repo/consumer.ts",
  accessedKeys,
  routesFetchedInFile,
});

describe("shapeCheck", () => {
  it("flags a key the consumer reads that the route never returns", () => {
    const result = shapeCheck([route(["data", "page"])], [consumer(["data", "total"])]);
    expect(result.mismatches).toHaveLength(1);
    const m = result.mismatches[0]!;
    expect(m.key).toBe("total");
    expect(m.confidence).toBe("high");
    expect(m.availableKeys).toEqual(["data", "page"]);
  });

  it("reads of returned keys produce no mismatch", () => {
    const result = shapeCheck([route(["data", "page"])], [consumer(["data", "page"])]);
    expect(result.mismatches).toHaveLength(0);
  });

  it("downgrades confidence to low when the consumer fetches multiple routes", () => {
    const result = shapeCheck([route(["data", "page"])], [consumer(["total"], 2)]);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]!.confidence).toBe("low");
  });

  it("checks against the UNION of all route keys", () => {
    const routes = [route(["data"]), { ...route(["page"]), symbolId: "r2", name: "GET /p" }];
    const result = shapeCheck(routes, [consumer(["data", "page"])]);
    expect(result.mismatches).toHaveLength(0);
  });

  it("never flags when there are no routes (avoids false positives)", () => {
    const result = shapeCheck([], [consumer(["whatever"])]);
    expect(result.mismatches).toHaveLength(0);
    expect(result.pairsChecked).toBe(0);
  });

  it("de-duplicates repeated reads of the same missing key", () => {
    const result = shapeCheck([route(["data"])], [consumer(["total", "total"])]);
    expect(result.mismatches).toHaveLength(1);
  });
});
