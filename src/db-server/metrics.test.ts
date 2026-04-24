import { describe, expect, it } from "vitest";

import { InMemoryMetricsCollector } from "./metrics.js";

describe("InMemoryMetricsCollector", () => {
  it("records per-endpoint counts, errors, and latency percentiles", () => {
    const collector = new InMemoryMetricsCollector({
      isDatabaseOpen: () => true,
      getSchedulerStats: () => ({
        inFlight: 2,
        queued: 3,
        totalProcessed: 10,
        totalTimedOut: 1,
        totalRejected: 1,
        acceptingRequests: true,
      }),
    });

    collector.recordRequest("Graph.QueryNodes", 10, "ok");
    collector.recordRequest("Graph.QueryNodes", 30, "error");
    collector.recordRequest("Graph.QueryNodes", 50, "timeout");
    collector.recordRequest("Vector.SemanticSearch", 7, "ok");

    const metrics = collector.getMetrics();

    expect(metrics.dbOpen).toBe(true);
    expect(metrics.inFlightRequests).toBe(2);
    expect(metrics.queuedRequests).toBe(3);
    expect(metrics.requestCounts).toEqual({
      "Graph.QueryNodes": 3,
      "Vector.SemanticSearch": 1,
    });
    expect(metrics.errorCounts).toEqual({
      "Graph.QueryNodes": 2,
    });
    expect(metrics.latencyP50Ms["Graph.QueryNodes"]).toBe(30);
    expect(metrics.latencyP99Ms["Graph.QueryNodes"]).toBe(50);
    expect(metrics.latencyP50Ms["Vector.SemanticSearch"]).toBe(7);
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(0);
  });
});
