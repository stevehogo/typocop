/**
 * Wave 8 · T5 — event-channel (findEventParticipants) tests.
 *
 * Query-aware mock GraphAdapter that branches on PUBLISHES_EVENT vs
 * SUBSCRIBES_TO, returning the fixture participant nodes as `{ n, confidence,
 * reason }` rows. Asserts the SUBSCRIBES_TO inversion (channel is the SOURCE) is
 * handled — both directions still project the PARTICIPANT as `n`.
 */
import { describe, it, expect } from "vitest";
import type { GraphAdapter } from "../../core/ports/persistence.js";
import { findEventParticipants } from "./event-channel.js";

interface ParticipantFixture {
  id: string;
  name: string;
  confidence?: string;
  reason?: string;
}

function nodeRow(p: ParticipantFixture) {
  return {
    n: {
      labels: ["Symbol"],
      properties: {
        id: p.id,
        name: p.name,
        kind: "method",
        filePath: `/repo/${p.id}.ts`,
        startLine: "5",
        startColumn: "0",
        endLine: "12",
        endColumn: "0",
        visibility: "public",
      },
    },
    confidence: p.confidence ?? null,
    reason: p.reason ?? null,
  };
}

function makeGraph(publishers: ParticipantFixture[], subscribers: ParticipantFixture[]): GraphAdapter {
  const runCypher = async <T,>(query: string): Promise<T[]> => {
    if (query.includes("PUBLISHES_EVENT")) return publishers.map(nodeRow) as unknown as T[];
    if (query.includes("SUBSCRIBES_TO")) return subscribers.map(nodeRow) as unknown as T[];
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

describe("findEventParticipants", () => {
  it("lists publishers via PUBLISHES_EVENT with provenance", async () => {
    const graph = makeGraph(
      [{ id: "p1", name: "emitOrderCreated", confidence: "0.6", reason: "emit-call-heuristic" }],
      [],
    );
    const result = await findEventParticipants(graph, "order.created", "publishers");
    expect(result.topic).toBe("order.created");
    expect(result.direction).toBe("publishers");
    expect(result.participants).toHaveLength(1);
    expect(result.participants[0].symbol.name).toBe("emitOrderCreated");
    expect(result.participants[0].confidence).toBe(0.6);
    expect(result.participants[0].reason).toBe("emit-call-heuristic");
  });

  it("lists subscribers via SUBSCRIBES_TO (channel-as-source inversion)", async () => {
    const graph = makeGraph(
      [],
      [{ id: "s1", name: "onOrderCreated", confidence: "0.85", reason: "decorator-OnEvent" }],
    );
    const result = await findEventParticipants(graph, "order.created", "subscribers");
    expect(result.direction).toBe("subscribers");
    expect(result.participants.map((p) => p.symbol.name)).toEqual(["onOrderCreated"]);
  });

  it("degrades to an empty result when no event edges exist (events sub-flag off)", async () => {
    const graph = makeGraph([], []);
    const result = await findEventParticipants(graph, "order.created", "subscribers");
    expect(result.participants).toHaveLength(0);
    expect(result.totalFound).toBe(0);
  });

  it("caps at maxResults but reports totalFound", async () => {
    const graph = makeGraph(
      [],
      Array.from({ length: 3 }, (_, i) => ({ id: `s${i}`, name: `sub${i}` })),
    );
    const result = await findEventParticipants(graph, "topic", "subscribers", { maxResults: 1 });
    expect(result.participants).toHaveLength(1);
    expect(result.totalFound).toBe(3);
  });
});
