import { describe, expect, it, vi } from "vitest";
import type { GraphAdapter, GraphNode } from "../core/ports/persistence.js";
import { executeImpactAnalysis, findExternalDependencyByAlias } from "./impact-analysis.js";

function makeGraphNode(
  id: string,
  labels: string[],
  properties: Record<string, string>,
): GraphNode {
  return { id, labels, properties: { id, ...properties } };
}

function makeAdapter(responses: unknown[][]): GraphAdapter {
  let index = 0;
  return {
    createNode: vi.fn(),
    createRelationship: vi.fn(),
    queryNodes: vi.fn(),
    queryRelationships: vi.fn(),
    deleteNodesByLabel: vi.fn(),
    deleteRelationshipsByType: vi.fn(),
    runCypher: vi.fn().mockImplementation(() => Promise.resolve(responses[index++] ?? [])),
    runCypherWrite: vi.fn(),
  };
}

describe("impact-analysis external dependencies", () => {
  it("matches external dependencies by alias case-insensitively", async () => {
    const adapter = makeAdapter([[
      {
        ext: {
          labels: ["ExternalDependency"],
          properties: { id: "ext:react-query", name: "react-query", aliases: "react-query,ReactQuery,reactquery" },
        },
      },
    ]]);

    const result = await findExternalDependencyByAlias(adapter, "reactquery");

    expect(result?.id).toBe("ext:react-query");
  });

  it("returns dependent symbols for external package impact analysis", async () => {
    const extNode = makeGraphNode("ext:lodash", ["ExternalDependency"], {
      name: "lodash",
      aliases: "lodash,Lodash",
      ecosystem: "npm",
    });
    const depNode = makeGraphNode("sym-1", ["Symbol"], {
      name: "useLodash",
      kind: "function",
      filePath: "/repo/src/use-lodash.ts",
      startLine: "1",
      startColumn: "0",
      endLine: "5",
      endColumn: "0",
      visibility: "public",
    });

    const adapter = makeAdapter([
      [],
      [{ ext: { labels: extNode.labels, properties: extNode.properties as Record<string, string> } }],
      [{ n: { labels: depNode.labels, properties: depNode.properties as Record<string, string> } }],
      [],
    ]);

    const result = await executeImpactAnalysis("lodash", 10, adapter);

    expect(result.targetKind).toBe("externalDependency");
    expect(result.targetName).toBe("lodash");
    expect(result.symbols).toHaveLength(1);
    expect(result.relationships).toContainEqual(expect.objectContaining({
      relType: "dependsOn",
      target: "ext:lodash",
    }));
  });
});
