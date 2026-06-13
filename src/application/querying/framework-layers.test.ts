/**
 * Unit tests for framework-layers.ts — detectFramework and classifyLayer.
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.6
 */
import { describe, it, expect } from "vitest";
import type { GraphNode } from "../../core/ports/persistence.js";
import { detectFramework, classifyLayer, GENERIC_LAYER_CONFIG } from "./framework-layers.js";

// ─── Factories ────────────────────────────────────────────────────────────────

/** Create a mock GraphNode with controllable properties. */
function getMockGraphNode(
  overrides?: Partial<{ id: string; name: string; filePath: string; signature: string }>,
): GraphNode {
  return {
    id: overrides?.id ?? "node-1",
    labels: ["Symbol"],
    properties: {
      id: overrides?.id ?? "node-1",
      name: overrides?.name ?? "SomeSymbol",
      filePath: overrides?.filePath ?? "src/index.ts",
      signature: overrides?.signature ?? "",
      kind: "function",
      startLine: "1",
      startColumn: "0",
      endLine: "10",
      endColumn: "1",
      visibility: "public",
    },
  };
}

// ─── detectFramework ──────────────────────────────────────────────────────────

describe("detectFramework", () => {
  /**
   * Validates: Requirement 4.1, 4.3 — NestJS detected from /controllers/ + .ts
   */
  it("detects NestJS from a TypeScript controllers path", () => {
    expect(detectFramework("/src/controllers/user.controller.ts")).toBe("nestjs");
  });

  /**
   * Validates: Requirement 4.1, 4.3 — Spring detected from /controller/ + .java
   */
  it("detects Spring from a Java controller path", () => {
    expect(detectFramework("/src/controller/UserController.java")).toBe("spring");
  });

  /**
   * Validates: Requirement 4.1, 4.3 — Laravel detected from /http/controllers/ + .php
   */
  it("detects Laravel from a PHP HTTP controllers path", () => {
    expect(detectFramework("/app/Http/Controllers/UserController.php")).toBe("laravel");
  });

  /**
   * Validates: Requirement 4.1, 4.3 — Express detected from /routes/ + .ts
   */
  it("detects Express from a TypeScript routes path", () => {
    expect(detectFramework("/src/routes/user.ts")).toBe("express");
  });

  /**
   * Validates: Requirement 4.1, 4.3 — Django detected from views.py
   */
  it("detects Django from a views.py file", () => {
    expect(detectFramework("/app/views.py")).toBe("django");
  });

  /**
   * Validates: Requirement 4.1, 4.3 — FastAPI detected from /routers/ + .py
   */
  it("detects FastAPI from a Python routers path", () => {
    expect(detectFramework("/app/routers/user.py")).toBe("fastapi");
  });

  /**
   * Validates: Requirement 4.1, 4.3 — Next.js detected from /pages/ path
   */
  it("detects Next.js from a pages API path", () => {
    expect(detectFramework("/pages/api/user.ts")).toBe("nextjs");
  });

  /**
   * Validates: Requirement 4.1, 4.3 — ASP.NET detected from /controllers/ + .cs
   */
  it("detects ASP.NET from a C# controllers path", () => {
    expect(detectFramework("/Controllers/UserController.cs")).toBe("aspnet");
  });

  /**
   * Validates: Requirement 4.3 — returns null for unknown paths
   */
  it("returns null for an unknown file path", () => {
    expect(detectFramework("/src/utils/helper.ts")).toBeNull();
  });

  it("handles paths without leading slash", () => {
    expect(detectFramework("src/controllers/user.controller.ts")).toBe("nestjs");
  });

  it("handles backslash paths (Windows)", () => {
    expect(detectFramework("src\\controllers\\user.controller.ts")).toBe("nestjs");
  });
});

// ─── classifyLayer ────────────────────────────────────────────────────────────

describe("classifyLayer", () => {
  /**
   * Validates: Requirement 4.2 — framework hint selects correct layer patterns.
   */
  it("classifies a controller node with NestJS framework hint", () => {
    const node = getMockGraphNode({
      name: "UserController",
      filePath: "/src/controllers/user.controller.ts",
    });

    const result = classifyLayer(node, "nestjs");

    expect(result).toBe("controller");
  });

  /**
   * Validates: Requirement 4.3, 4.6 — auto-detects framework from filePath.
   */
  it("auto-detects NestJS and classifies correctly without hint", () => {
    const node = getMockGraphNode({
      name: "UserController",
      filePath: "/src/controllers/user.controller.ts",
    });

    const result = classifyLayer(node);

    expect(result).toBe("controller");
  });

  /**
   * Validates: Requirement 4.4 — generic fallback when no framework detected.
   */
  it("falls back to generic patterns for a service node without framework", () => {
    const node = getMockGraphNode({
      name: "UserService",
      filePath: "/src/utils/user-service.ts",
    });

    const result = classifyLayer(node);

    expect(result).toBe("service");
  });

  /**
   * Validates: Requirement 4.4 — unknown framework hint falls back to generic.
   */
  it("falls back to generic when framework hint is unrecognized", () => {
    const node = getMockGraphNode({
      name: "UserService",
      filePath: "/src/services/user.ts",
    });

    const result = classifyLayer(node, "unknown-framework");

    expect(result).toBe("service");
  });

  it("returns 'unknown' when no pattern matches", () => {
    const node = getMockGraphNode({
      name: "doSomething",
      filePath: "/src/lib/misc.ts",
    });

    const result = classifyLayer(node);

    expect(result).toBe("unknown");
  });

  /**
   * Validates: Requirement 4.6 — classifyLayer uses name, filePath, and signature.
   */
  it("matches against signature property", () => {
    const node = getMockGraphNode({
      name: "handle",
      filePath: "/src/lib/misc.ts",
      signature: "@Get('/users')",
    });

    const result = classifyLayer(node, "nestjs");

    expect(result).toBe("api");
  });

  it("classifies Spring controller from Java path with hint", () => {
    const node = getMockGraphNode({
      name: "UserController",
      filePath: "/src/controller/UserController.java",
    });

    const result = classifyLayer(node, "spring");

    expect(result).toBe("controller");
  });

  it("classifies Laravel controller from PHP path", () => {
    const node = getMockGraphNode({
      name: "UserController",
      filePath: "/app/Http/Controllers/UserController.php",
    });

    const result = classifyLayer(node);

    expect(result).toBe("controller");
  });
});

// ─── Generic fallback matches LAYER_PATTERNS ──────────────────────────────────

describe("GENERIC_LAYER_CONFIG matches original LAYER_PATTERNS", () => {
  const genericLayers = GENERIC_LAYER_CONFIG.layers;

  /** Original LAYER_PATTERNS from data-flow-trace.ts for comparison. */
  const ORIGINAL_LAYER_PATTERNS = {
    api: [/endpoint/i, /route/i, /controller.*action/i, /api/i, /@get/i, /@post/i, /@put/i, /@delete/i],
    controller: [/controller/i, /handler/i],
    service: [/service/i, /manager/i, /business/i],
    repository: [/repository/i, /dao/i, /store/i],
    model: [/model/i, /entity/i, /schema/i, /table/i],
  };

  const testCases: Array<{ input: string; expectedLayer: string }> = [
    { input: "endpoint handler", expectedLayer: "api" },
    { input: "route definition", expectedLayer: "api" },
    { input: "@Get decorator", expectedLayer: "api" },
    { input: "UserController", expectedLayer: "controller" },
    { input: "requestHandler", expectedLayer: "controller" },
    { input: "UserService", expectedLayer: "service" },
    { input: "TaskManager", expectedLayer: "service" },
    { input: "UserRepository", expectedLayer: "repository" },
    { input: "dataStore", expectedLayer: "repository" },
    { input: "UserModel", expectedLayer: "model" },
    { input: "OrderEntity", expectedLayer: "model" },
    { input: "tableSchema", expectedLayer: "model" },
  ];

  for (const { input, expectedLayer } of testCases) {
    it(`classifies "${input}" as "${expectedLayer}" matching original LAYER_PATTERNS`, () => {
      // Verify original patterns match
      const originalPatterns = ORIGINAL_LAYER_PATTERNS[expectedLayer as keyof typeof ORIGINAL_LAYER_PATTERNS];
      const originalMatches = originalPatterns.some((p) => p.test(input));
      expect(originalMatches).toBe(true);

      // Verify generic config matches the same way
      const genericPatterns = genericLayers[expectedLayer as keyof typeof genericLayers];
      const genericMatches = genericPatterns.some((p: RegExp) => p.test(input));
      expect(genericMatches).toBe(true);
    });
  }

  it("generic fallback classifyLayer matches original behavior for a service node", () => {
    const node = getMockGraphNode({ name: "UserService" });

    // No framework hint, unknown path → generic fallback
    const result = classifyLayer(node);

    expect(result).toBe("service");
  });

  it("generic fallback classifyLayer matches original behavior for a model node", () => {
    const node = getMockGraphNode({ name: "OrderEntity" });

    const result = classifyLayer(node);

    expect(result).toBe("model");
  });
});

// ─── Property-Based Tests ─────────────────────────────────────────────────────

import * as fc from "fast-check";
import type { TraceLayer } from "./framework-layers.js";

/** Valid TraceLayer values. */
const VALID_LAYERS: readonly TraceLayer[] = ["api", "controller", "service", "repository", "model", "unknown"] as const;

/** Arbitrary that produces a GraphNode with random string properties. */
const graphNodeArbitrary: fc.Arbitrary<GraphNode> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 50 }),
  name: fc.string({ maxLength: 80 }),
  filePath: fc.string({ maxLength: 120 }),
  signature: fc.string({ maxLength: 100 }),
}).map(({ id, name, filePath, signature }) => ({
  id,
  labels: ["Symbol"],
  properties: {
    id,
    name,
    filePath,
    signature,
    kind: "function",
    startLine: "1",
    startColumn: "0",
    endLine: "10",
    endColumn: "1",
    visibility: "public",
  },
}));

/** Arbitrary for optional framework hint strings (including unknown ones). */
const frameworkHintArbitrary: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.constantFrom("nestjs", "spring", "laravel", "express", "django", "fastapi", "nextjs", "aspnet"),
  fc.string({ minLength: 1, maxLength: 30 }),
);

/**
 * Validates: Requirements 4.6
 * Property: classifyLayer always returns a valid TraceLayer value.
 */
describe("Property-based: classifyLayer", () => {
  it("always returns a valid TraceLayer for arbitrary GraphNode inputs", () => {
    fc.assert(
      fc.property(graphNodeArbitrary, frameworkHintArbitrary, (node, hint) => {
        const result = classifyLayer(node, hint);
        expect(VALID_LAYERS).toContain(result);
      }),
      { numRuns: 200 },
    );
  });

  it("never throws for any GraphNode and optional framework hint", () => {
    fc.assert(
      fc.property(graphNodeArbitrary, frameworkHintArbitrary, (node, hint) => {
        // Should not throw — just return a valid layer
        expect(() => classifyLayer(node, hint)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });
});

/**
 * Validates: Requirements 4.6
 * Property 8: Framework detection determinism — detectFramework(path) returns the same result for the same input.
 */
describe("Property-based: detectFramework", () => {
  it("is deterministic: calling twice with the same path returns the same result", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 150 }), (path) => {
        const first = detectFramework(path);
        const second = detectFramework(path);
        expect(first).toBe(second);
      }),
      { numRuns: 200 },
    );
  });
});
