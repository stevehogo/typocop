/**
 * Unit tests for SemanticClusterClassifier.
 *
 * Tests:
 * - Classifier returns correct category when similarity is above threshold
 * - Classifier returns "unknown" when all similarities are below threshold
 * - Classifier caches category embeddings after first initialization
 * - enrichCluster uses semantic classification when embeddings enabled
 * - enrichCluster falls back to keyword classification when embeddings disabled
 * - Privacy check is applied to cluster text
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EmbeddingAdapter } from "../../../core/ports/persistence.js";
import type { Cluster, ClusterCategory, Embedding, Symbol } from "../../../core/domain.js";
import {
  SemanticClusterClassifier,
  cosineSimilarity,
  buildClusterText,
  SEMANTIC_THRESHOLD,
  CATEGORY_REFERENCE_TEXTS,
} from "./semantic-classifier.js";
import { enrichCluster, resetSharedClassifier } from "./enrichment.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSymbol(
  id: string,
  name: string,
  kind: Symbol["kind"] = "function",
  signature?: string,
): Symbol {
  return {
    id,
    name,
    kind,
    location: { filePath: "src/foo.ts", startLine: 1, startColumn: 0, endLine: 5, endColumn: 0 },
    visibility: "public",
    modifiers: [],
    ...(signature ? { signature } : {}),
  };
}

function makeCluster(symbols: string[], category: ClusterCategory = "unknown"): Cluster {
  return {
    id: "cluster_0",
    name: "test-cluster",
    symbols,
    confidence: 0.8,
    category,
  };
}

/** Create a unit vector pointing in a specific direction (dimension index). */
function makeUnitVector(dim: number, activeDim: number): number[] {
  const v = new Array(dim).fill(0);
  v[activeDim] = 1.0;
  return v;
}

function makeEmbedding(vector: number[]): Embedding {
  return { vector, dimensions: vector.length };
}

/**
 * Creates a mock EmbeddingAdapter that maps specific texts to specific vectors.
 * Category reference texts get distinct unit vectors; cluster text gets a vector
 * close to one of them.
 */
function createMockEmbedder(
  textToVector: Map<string, number[]>,
  enabled = true,
): EmbeddingAdapter {
  return {
    isEnabled: () => enabled,
    embedText: vi.fn(async (text: string): Promise<Embedding | null> => {
      const vec = textToVector.get(text);
      if (vec) return makeEmbedding(vec);
      // Default: return a zero vector
      return makeEmbedding(new Array(5).fill(0));
    }),
    getDimensions: () => 5,
  };
}

// ─── cosineSimilarity ─────────────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0);
  });

  it("returns -1.0 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for zero vectors", () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });
});

// ─── buildClusterText ─────────────────────────────────────────────────────────

describe("buildClusterText", () => {
  it("aggregates symbol names, kinds, and signatures", () => {
    const symbols = [
      makeSymbol("a", "loginUser", "function", "loginUser(email: string): Promise<User>"),
      makeSymbol("b", "validateToken", "function"),
    ];
    const symbolMap = new Map(symbols.map((s) => [s.id, s]));
    const text = buildClusterText(["a", "b"], symbolMap);
    expect(text).toContain("loginUser (function)");
    expect(text).toContain("loginUser(email: string): Promise<User>");
    expect(text).toContain("validateToken (function)");
  });

  it("skips missing symbol IDs", () => {
    const symbolMap = new Map<string, Symbol>();
    const text = buildClusterText(["missing"], symbolMap);
    expect(text).toBe("");
  });

  it("throws on source code in text (privacy check)", () => {
    const sym = makeSymbol(
      "a",
      "badFunc",
      "function",
      undefined,
    );
    // Manually create a symbol with source code in the signature
    const badSym: Symbol = {
      ...sym,
      signature: "function badFunc(x) {\n  return x + 1;\n  const y = 2;\n}",
    };
    const symbolMap = new Map([["a", badSym]]);
    expect(() => buildClusterText(["a"], symbolMap)).toThrow(/Privacy violation/);
  });
});

// ─── SemanticClusterClassifier ────────────────────────────────────────────────

describe("SemanticClusterClassifier", () => {
  it("returns correct category when similarity is above threshold", async () => {
    // Set up: authentication reference text → unit vector dim 0
    // Cluster text → same direction (cosine sim = 1.0)
    const textToVector = new Map<string, number[]>();
    textToVector.set(CATEGORY_REFERENCE_TEXTS.authentication, makeUnitVector(5, 0));
    textToVector.set(CATEGORY_REFERENCE_TEXTS.dataAccess, makeUnitVector(5, 1));
    textToVector.set(CATEGORY_REFERENCE_TEXTS.businessLogic, makeUnitVector(5, 2));
    textToVector.set(CATEGORY_REFERENCE_TEXTS.uiComponent, makeUnitVector(5, 3));
    textToVector.set(CATEGORY_REFERENCE_TEXTS.utility, makeUnitVector(5, 4));
    // Cluster text maps to authentication direction
    textToVector.set("loginUser (function), validateToken (function)", makeUnitVector(5, 0));

    const embedder = createMockEmbedder(textToVector);
    const classifier = new SemanticClusterClassifier();
    await classifier.initialize(embedder);

    const result = await classifier.classify("loginUser (function), validateToken (function)");
    expect(result).toBe("authentication");
  });

  it("returns 'unknown' when all similarities are below threshold", async () => {
    // All category embeddings are unit vectors; cluster text is a zero vector
    const textToVector = new Map<string, number[]>();
    textToVector.set(CATEGORY_REFERENCE_TEXTS.authentication, makeUnitVector(5, 0));
    textToVector.set(CATEGORY_REFERENCE_TEXTS.dataAccess, makeUnitVector(5, 1));
    textToVector.set(CATEGORY_REFERENCE_TEXTS.businessLogic, makeUnitVector(5, 2));
    textToVector.set(CATEGORY_REFERENCE_TEXTS.uiComponent, makeUnitVector(5, 3));
    textToVector.set(CATEGORY_REFERENCE_TEXTS.utility, makeUnitVector(5, 4));
    // Cluster text → zero vector (cosine sim = 0 with everything)

    const embedder = createMockEmbedder(textToVector);
    const classifier = new SemanticClusterClassifier();
    await classifier.initialize(embedder);

    const result = await classifier.classify("some random text");
    expect(result).toBe("unknown");
  });

  it("returns 'unknown' when not initialized", async () => {
    const classifier = new SemanticClusterClassifier();
    const result = await classifier.classify("anything");
    expect(result).toBe("unknown");
  });

  it("returns 'unknown' when embedText returns null for cluster text", async () => {
    const textToVector = new Map<string, number[]>();
    textToVector.set(CATEGORY_REFERENCE_TEXTS.authentication, makeUnitVector(5, 0));
    textToVector.set(CATEGORY_REFERENCE_TEXTS.dataAccess, makeUnitVector(5, 1));
    textToVector.set(CATEGORY_REFERENCE_TEXTS.businessLogic, makeUnitVector(5, 2));
    textToVector.set(CATEGORY_REFERENCE_TEXTS.uiComponent, makeUnitVector(5, 3));
    textToVector.set(CATEGORY_REFERENCE_TEXTS.utility, makeUnitVector(5, 4));

    const embedder: EmbeddingAdapter = {
      isEnabled: () => true,
      embedText: vi.fn(async (text: string) => {
        const vec = textToVector.get(text);
        if (vec) return makeEmbedding(vec);
        return null; // cluster text returns null
      }),
      getDimensions: () => 5,
    };

    const classifier = new SemanticClusterClassifier();
    await classifier.initialize(embedder);

    const result = await classifier.classify("unknown cluster text");
    expect(result).toBe("unknown");
  });

  it("caches category embeddings after first initialization", async () => {
    const textToVector = new Map<string, number[]>();
    textToVector.set(CATEGORY_REFERENCE_TEXTS.authentication, makeUnitVector(5, 0));
    textToVector.set(CATEGORY_REFERENCE_TEXTS.dataAccess, makeUnitVector(5, 1));
    textToVector.set(CATEGORY_REFERENCE_TEXTS.businessLogic, makeUnitVector(5, 2));
    textToVector.set(CATEGORY_REFERENCE_TEXTS.uiComponent, makeUnitVector(5, 3));
    textToVector.set(CATEGORY_REFERENCE_TEXTS.utility, makeUnitVector(5, 4));

    const embedder = createMockEmbedder(textToVector);
    const classifier = new SemanticClusterClassifier();
    await classifier.initialize(embedder);

    // embedText should have been called exactly 5 times (once per category)
    expect(embedder.embedText).toHaveBeenCalledTimes(5);

    // Classify multiple times — no additional embedText calls for categories
    textToVector.set("text1", makeUnitVector(5, 0));
    textToVector.set("text2", makeUnitVector(5, 1));
    await classifier.classify("text1");
    await classifier.classify("text2");

    // 5 (init) + 2 (classify calls) = 7 total
    expect(embedder.embedText).toHaveBeenCalledTimes(7);
  });

  it("isInitialized returns false before initialize, true after", async () => {
    const classifier = new SemanticClusterClassifier();
    expect(classifier.isInitialized()).toBe(false);

    const textToVector = new Map<string, number[]>();
    textToVector.set(CATEGORY_REFERENCE_TEXTS.authentication, makeUnitVector(5, 0));
    textToVector.set(CATEGORY_REFERENCE_TEXTS.dataAccess, makeUnitVector(5, 1));
    textToVector.set(CATEGORY_REFERENCE_TEXTS.businessLogic, makeUnitVector(5, 2));
    textToVector.set(CATEGORY_REFERENCE_TEXTS.uiComponent, makeUnitVector(5, 3));
    textToVector.set(CATEGORY_REFERENCE_TEXTS.utility, makeUnitVector(5, 4));

    await classifier.initialize(createMockEmbedder(textToVector));
    expect(classifier.isInitialized()).toBe(true);
  });
});


// ─── enrichCluster integration ────────────────────────────────────────────────

describe("enrichCluster with semantic classification", () => {
  beforeEach(() => {
    resetSharedClassifier();
  });

  it("uses semantic classification when embeddings are enabled", async () => {
    const symbols = [
      makeSymbol("a", "loginUser", "function"),
      makeSymbol("b", "validateToken", "function"),
    ];
    const symbolMap = new Map(symbols.map((s) => [s.id, s]));
    const cluster = makeCluster(["a", "b"]);

    // Map category texts to distinct vectors, cluster text to authentication
    const textToVector = new Map<string, number[]>();
    textToVector.set(CATEGORY_REFERENCE_TEXTS.authentication, makeUnitVector(5, 0));
    textToVector.set(CATEGORY_REFERENCE_TEXTS.dataAccess, makeUnitVector(5, 1));
    textToVector.set(CATEGORY_REFERENCE_TEXTS.businessLogic, makeUnitVector(5, 2));
    textToVector.set(CATEGORY_REFERENCE_TEXTS.uiComponent, makeUnitVector(5, 3));
    textToVector.set(CATEGORY_REFERENCE_TEXTS.utility, makeUnitVector(5, 4));
    // Cluster text → authentication direction
    textToVector.set("loginUser (function), validateToken (function)", makeUnitVector(5, 0));

    const embedder = createMockEmbedder(textToVector, true);

    const enriched = await enrichCluster(
      cluster,
      symbolMap,
      "test-label",
      undefined,
      embedder,
    );

    expect(enriched.category).toBe("authentication");
  });

  it("falls back to keyword classification when embeddings are disabled", async () => {
    const symbols = [
      makeSymbol("a", "loginUser", "function"),
      makeSymbol("b", "validateToken", "function"),
    ];
    const symbolMap = new Map(symbols.map((s) => [s.id, s]));
    const cluster = makeCluster(["a", "b"]);

    const disabledEmbedder: EmbeddingAdapter = {
      isEnabled: () => false,
      embedText: vi.fn(async () => null),
      getDimensions: () => 5,
    };

    const enriched = await enrichCluster(
      cluster,
      symbolMap,
      "test-label",
      undefined,
      disabledEmbedder,
    );

    // Keyword-based classification should detect "login" and "token" → authentication
    expect(enriched.category).toBe("authentication");
    // embedText should never be called when disabled
    expect(disabledEmbedder.embedText).not.toHaveBeenCalled();
  });

  it("falls back to keyword classification when no embeddingAdapter provided", async () => {
    const symbols = [
      makeSymbol("a", "UserRepository", "class"),
      makeSymbol("b", "findByEmail", "method"),
    ];
    const symbolMap = new Map(symbols.map((s) => [s.id, s]));
    const cluster = makeCluster(["a", "b"]);

    const enriched = await enrichCluster(
      cluster,
      symbolMap,
      "test-label",
    );

    expect(enriched.category).toBe("dataAccess");
  });

  it("returns cluster unchanged when fewer than 2 symbols", async () => {
    const symbols = [makeSymbol("a", "loginUser", "function")];
    const symbolMap = new Map(symbols.map((s) => [s.id, s]));
    const cluster = makeCluster(["a"]);

    const enriched = await enrichCluster(
      cluster,
      symbolMap,
      "test-label",
    );

    expect(enriched).toEqual(cluster);
  });
});
