/**
 * Tests for the batch-or-fallback persistence helpers (Phase D / PR7).
 *
 * Verifies the keystone invariant: behavior is IDENTICAL whether or not an
 * adapter implements the OPTIONAL batch methods —
 *   - same data written,
 *   - same grouping (single label / single type),
 *   - chunk sizes bounded by per-entity caps on the batch path,
 *   - row-accurate counts (onRows totals === number of rows) on BOTH paths.
 */
import { describe, it, expect, vi } from "vitest";
import type { Embedding } from "../../core/domain.js";
import type { GraphAdapter, VectorAdapter } from "../../core/ports/persistence.js";
import {
  DB_NODE_WRITE_BATCH_SIZE,
  DB_RELATIONSHIP_WRITE_BATCH_SIZE,
  DB_VECTOR_WRITE_BATCH_SIZE,
  GRPC_MAX_MESSAGE_BYTES_ENV,
  getRpcPayloadBudgetBytes,
} from "../../platform/utils/limits.js";
import {
  chunk,
  chunkByBudget,
  writeNodeGroup,
  writeRelationshipGroup,
  writeVectorEntries,
  type PersistEvents,
  type RelationshipRow,
  type VectorEntry,
} from "./persistence-helpers.js";

const EMBEDDING: Embedding = { vector: [0.1, 0.2], dimensions: 2 };

// ─── Adapter factories ──────────────────────────────────────────────────────

function makeGraphNoBatch(): GraphAdapter {
  return {
    createNode: vi.fn().mockResolvedValue(undefined),
    createRelationship: vi.fn().mockResolvedValue(undefined),
    queryNodes: vi.fn().mockResolvedValue([]),
    queryRelationships: vi.fn().mockResolvedValue([]),
    deleteNodesByLabel: vi.fn().mockResolvedValue(0),
    deleteRelationshipsByType: vi.fn().mockResolvedValue(0),
    runCypher: vi.fn().mockResolvedValue([]),
    runCypherWrite: vi.fn().mockResolvedValue(undefined),
  };
}

function makeGraphWithBatch(): GraphAdapter {
  return {
    ...makeGraphNoBatch(),
    createNodes: vi.fn().mockResolvedValue(undefined),
    createRelationships: vi.fn().mockResolvedValue(undefined),
  };
}

function makeVectorNoBatch(): VectorAdapter {
  return {
    createTables: vi.fn().mockResolvedValue(undefined),
    indexSymbol: vi.fn().mockResolvedValue(undefined),
    semanticSearch: vi.fn().mockResolvedValue([]),
    deleteAll: vi.fn().mockResolvedValue(0),
  };
}

function makeVectorWithBatch(): VectorAdapter {
  return { ...makeVectorNoBatch(), indexSymbols: vi.fn().mockResolvedValue(undefined) };
}

// ─── chunk() ─────────────────────────────────────────────────────────────────

describe("chunk", () => {
  it("splits into bounded consecutive chunks whose union equals input", () => {
    const items = Array.from({ length: 23 }, (_, i) => i);
    const parts = chunk(items, 10);
    expect(parts.map((p) => p.length)).toEqual([10, 10, 3]);
    expect(parts.flat()).toEqual(items);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(10);
  });

  it("returns no chunks for empty input", () => {
    expect(chunk([], 5)).toEqual([]);
  });

  it("rejects a non-positive chunk size", () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

// ─── chunkByBudget() ─────────────────────────────────────────────────────────

describe("chunkByBudget", () => {
  it("respects maxBytes and maxCount without dropping or duplicating items", () => {
    const items = [
      { id: "a", payload: "1111" },
      { id: "b", payload: "2222" },
      { id: "c", payload: "3333" },
      { id: "d", payload: "4444" },
    ];
    const parts = chunkByBudget(items, {
      maxBytes: JSON.stringify(items.slice(0, 2)).length,
      maxCount: 2,
      sizeOf: (item) => JSON.stringify(item).length,
    });

    expect(parts.flat()).toEqual(items);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(2);
      expect(JSON.stringify(part).length).toBeLessThanOrEqual(
        JSON.stringify(items.slice(0, 2)).length,
      );
    }
  });

  it("emits a lone oversized item as its own chunk and warns through the callback", () => {
    const oversized = { id: "huge", payload: "x".repeat(100) };
    const warnings: string[] = [];

    const parts = chunkByBudget([oversized, { id: "small" }], {
      maxBytes: 32,
      maxCount: 10,
      sizeOf: (item) => JSON.stringify(item).length,
      onOversizedItem: (item) => warnings.push((item as { id: string }).id),
    });

    expect(parts).toEqual([[oversized], [{ id: "small" }]]);
    expect(warnings).toEqual(["huge"]);
  });

  it("returns no chunks for empty input", () => {
    expect(chunkByBudget([], {
      maxBytes: 10,
      maxCount: 10,
      sizeOf: () => 1,
    })).toEqual([]);
  });
});

// ─── writeNodeGroup ───────────────────────────────────────────────────────────

describe("writeNodeGroup", () => {
  const rows = Array.from({ length: 1100 }, (_, i) => ({ id: `n${i}` }));

  it("falls back to per-row createNode when createNodes is absent; counts == rows", async () => {
    const g = makeGraphNoBatch();
    let counted = 0;
    await writeNodeGroup(g, "Symbol", rows, (n) => (counted += n));

    expect(g.createNode).toHaveBeenCalledTimes(rows.length);
    expect(counted).toBe(rows.length);
    // Single-label grouping: every call uses "Symbol".
    for (const call of (g.createNode as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0]).toBe("Symbol");
    }
  });

  it("uses createNodes (chunked, bounded) when present; counts == rows not batches", async () => {
    const g = makeGraphWithBatch();
    let counted = 0;
    await writeNodeGroup(g, "Symbol", rows, (n) => (counted += n));

    const calls = (g.createNodes as ReturnType<typeof vi.fn>).mock.calls;
    expect(g.createNode).not.toHaveBeenCalled();
    // Bounded chunks; union of rows == all rows; grouped by single label.
    const seen: Array<Record<string, unknown>> = [];
    for (const [label, part] of calls) {
      expect(label).toBe("Symbol");
      expect(part.length).toBeLessThanOrEqual(DB_NODE_WRITE_BATCH_SIZE);
      seen.push(...part);
    }
    expect(seen).toEqual(rows);
    // Row-accurate: total counted equals rows, while batch CALLS are far fewer.
    expect(counted).toBe(rows.length);
    expect(calls.length).toBeLessThan(rows.length);
    expect(calls.length).toBe(Math.ceil(rows.length / DB_NODE_WRITE_BATCH_SIZE));
  });

  it("no-ops on empty input", async () => {
    const g = makeGraphWithBatch();
    let counted = 0;
    await writeNodeGroup(g, "Symbol", [], (n) => (counted += n));
    expect(g.createNodes).not.toHaveBeenCalled();
    expect(counted).toBe(0);
  });

  it("keeps batch node JSON payloads within the configured budget", async () => {
    const previous = process.env[GRPC_MAX_MESSAGE_BYTES_ENV];
    process.env[GRPC_MAX_MESSAGE_BYTES_ENV] = "160";
    try {
      const budget = getRpcPayloadBudgetBytes();
      const budgetedRows = Array.from({ length: 5 }, (_, i) => ({
        id: `n${i}`,
        payload: "x".repeat(18),
      }));
      const g = makeGraphWithBatch();

      await writeNodeGroup(g, "Symbol", budgetedRows, () => {});

      const calls = (g.createNodes as ReturnType<typeof vi.fn>).mock.calls as Array<[
        string,
        Array<Record<string, unknown>>,
      ]>;
      expect(calls.length).toBeGreaterThan(1);
      for (const [, part] of calls) {
        expect(JSON.stringify(part).length).toBeLessThanOrEqual(budget);
      }
    } finally {
      if (previous === undefined) {
        delete process.env[GRPC_MAX_MESSAGE_BYTES_ENV];
      } else {
        process.env[GRPC_MAX_MESSAGE_BYTES_ENV] = previous;
      }
    }
  });
});

// ─── writeRelationshipGroup ────────────────────────────────────────────────────

describe("writeRelationshipGroup", () => {
  const rows: RelationshipRow[] = Array.from({ length: 750 }, (_, i) => ({
    fromId: `a${i}`,
    toId: `b${i}`,
    properties: { i: String(i) },
  }));

  it("falls back to per-row createRelationship when createRelationships absent; counts == rows", async () => {
    const g = makeGraphNoBatch();
    let counted = 0;
    await writeRelationshipGroup(g, "CONTAINS", rows, (n) => (counted += n));

    expect(g.createRelationship).toHaveBeenCalledTimes(rows.length);
    expect(counted).toBe(rows.length);
    const calls = (g.createRelationship as ReturnType<typeof vi.fn>).mock.calls;
    // Signature: (fromId, toId, type, properties)
    expect(calls[0]).toEqual(["a0", "b0", "CONTAINS", { i: "0" }]);
  });

  it("uses createRelationships (chunked, bounded, single-type) when present; counts == rows", async () => {
    const g = makeGraphWithBatch();
    let counted = 0;
    await writeRelationshipGroup(g, "CONTAINS", rows, (n) => (counted += n));

    expect(g.createRelationship).not.toHaveBeenCalled();
    const calls = (g.createRelationships as ReturnType<typeof vi.fn>).mock.calls;
    const seen: RelationshipRow[] = [];
    for (const [type, part] of calls) {
      expect(type).toBe("CONTAINS");
      expect(part.length).toBeLessThanOrEqual(DB_RELATIONSHIP_WRITE_BATCH_SIZE);
      seen.push(...part);
    }
    expect(seen).toEqual(rows);
    expect(counted).toBe(rows.length);
    expect(calls.length).toBe(Math.ceil(rows.length / DB_RELATIONSHIP_WRITE_BATCH_SIZE));
  });
});

// ─── writeVectorEntries ────────────────────────────────────────────────────────

describe("writeVectorEntries", () => {
  const entries: VectorEntry[] = Array.from({ length: 600 }, (_, i) => ({
    symbolId: `s${i}`,
    embedding: EMBEDDING,
    metadata: { c: String(i) },
  }));

  it("falls back to per-row indexSymbol when indexSymbols absent; counts == rows", async () => {
    const v = makeVectorNoBatch();
    let counted = 0;
    await writeVectorEntries(v, entries, (n) => (counted += n));

    expect(v.indexSymbol).toHaveBeenCalledTimes(entries.length);
    expect(counted).toBe(entries.length);
    expect((v.indexSymbol as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      "s0",
      EMBEDDING,
      { c: "0" },
    ]);
  });

  it("uses indexSymbols (chunked, bounded) when present; counts == rows", async () => {
    const v = makeVectorWithBatch();
    let counted = 0;
    await writeVectorEntries(v, entries, (n) => (counted += n));

    expect(v.indexSymbol).not.toHaveBeenCalled();
    const calls = (v.indexSymbols as ReturnType<typeof vi.fn>).mock.calls;
    const seen: VectorEntry[] = [];
    for (const [part] of calls) {
      expect(part.length).toBeLessThanOrEqual(DB_VECTOR_WRITE_BATCH_SIZE);
      seen.push(...part);
    }
    expect(seen).toEqual(entries);
    expect(counted).toBe(entries.length);
    expect(calls.length).toBe(Math.ceil(entries.length / DB_VECTOR_WRITE_BATCH_SIZE));
  });

  it("splits and retries a rejected batch on RESOURCE_EXHAUSTED", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const v = makeVectorWithBatch();
    const indexSymbols = v.indexSymbols as ReturnType<typeof vi.fn>;
    indexSymbols.mockImplementation(async (part: readonly VectorEntry[]) => {
      if (part.length > 2) {
        throw Object.assign(new Error("too large"), { code: 8 });
      }
    });

    const smallEntries = entries.slice(0, 4);
    let counted = 0;
    await writeVectorEntries(v, smallEntries, (n) => (counted += n));

    expect(indexSymbols.mock.calls.map(([part]) => part.length)).toEqual([4, 2, 2]);
    expect(counted).toBe(4);
    warn.mockRestore();
  });

  it("fails loudly when a single row is still RESOURCE_EXHAUSTED", async () => {
    const v = makeVectorWithBatch();
    const indexSymbols = v.indexSymbols as ReturnType<typeof vi.fn>;
    indexSymbols.mockRejectedValue(Object.assign(new Error("too large"), { code: 8 }));

    await expect(writeVectorEntries(v, entries.slice(0, 1), () => {}))
      .rejects.toThrow("single row exceeds the configured gRPC message limit");
  });

  it("keeps vector batch JSON payloads within the configured budget", async () => {
    const previous = process.env[GRPC_MAX_MESSAGE_BYTES_ENV];
    process.env[GRPC_MAX_MESSAGE_BYTES_ENV] = "220";
    try {
      const budget = getRpcPayloadBudgetBytes();
      const budgetedEntries: VectorEntry[] = Array.from({ length: 5 }, (_, i) => ({
        symbolId: `s${i}`,
        embedding: { vector: [0.1, 0.2, 0.3], dimensions: 3 },
        metadata: { kind: "function" },
      }));
      const v = makeVectorWithBatch();

      await writeVectorEntries(v, budgetedEntries, () => {});

      const calls = (v.indexSymbols as ReturnType<typeof vi.fn>).mock.calls as Array<[VectorEntry[]]>;
      expect(calls.length).toBeGreaterThan(1);
      for (const [part] of calls) {
        expect(JSON.stringify(part).length).toBeLessThanOrEqual(budget);
      }
    } finally {
      if (previous === undefined) {
        delete process.env[GRPC_MAX_MESSAGE_BYTES_ENV];
      } else {
        process.env[GRPC_MAX_MESSAGE_BYTES_ENV] = previous;
      }
    }
  });
});

// ─── Both paths write identical data ───────────────────────────────────────────

describe("batch and fallback paths write identical data", () => {
  it("nodes: flattened (label,row) set matches", async () => {
    const rows = Array.from({ length: 1234 }, (_, i) => ({ id: `n${i}`, k: i % 3 }));

    const fallback = makeGraphNoBatch();
    await writeNodeGroup(fallback, "Symbol", rows, () => {});
    const fallbackData = (fallback.createNode as ReturnType<typeof vi.fn>).mock.calls.map(
      ([label, row]) => ({ label, row }),
    );

    const batch = makeGraphWithBatch();
    await writeNodeGroup(batch, "Symbol", rows, () => {});
    const createNodesCalls = (batch.createNodes as ReturnType<typeof vi.fn>).mock
      .calls as Array<[string, Array<Record<string, unknown>>]>;
    const batchData = createNodesCalls.flatMap(([label, part]) =>
      part.map((row) => ({ label, row })),
    );

    expect(batchData).toEqual(fallbackData);
    expect(batchData).toEqual(rows.map((row) => ({ label: "Symbol", row })));
  });

  it("relationships: flattened (type,fromId,toId,props) set matches", async () => {
    const rows: RelationshipRow[] = Array.from({ length: 1234 }, (_, i) => ({
      fromId: `a${i}`,
      toId: `b${i}`,
      properties: { i: String(i) },
    }));

    const fallback = makeGraphNoBatch();
    await writeRelationshipGroup(fallback, "HAS_STEP", rows, () => {});
    const fallbackData = (fallback.createRelationship as ReturnType<typeof vi.fn>).mock.calls.map(
      ([fromId, toId, type, properties]) => ({ type, fromId, toId, properties }),
    );

    const batch = makeGraphWithBatch();
    await writeRelationshipGroup(batch, "HAS_STEP", rows, () => {});
    const createRelationshipCalls = (batch.createRelationships as ReturnType<typeof vi.fn>).mock
      .calls as Array<[string, RelationshipRow[]]>;
    const batchData = createRelationshipCalls.flatMap(([type, part]) =>
      part.map((r) => ({ type, fromId: r.fromId, toId: r.toId, properties: r.properties })),
    );

    expect(batchData).toEqual(fallbackData);
  });
});

// ─── Batch-level event callbacks (Phase B) ──────────────────────────────────────

describe("PersistEvents callbacks (Phase B)", () => {
  function makeCountingEvents(): PersistEvents & {
    counts: { batch: number; split: number; oversized: number };
  } {
    const counts = { batch: 0, split: 0, oversized: 0 };
    return {
      counts,
      onBatch: () => (counts.batch += 1),
      onSplit: () => (counts.split += 1),
      onOversized: () => (counts.oversized += 1),
    };
  }

  it("fires onBatch once per batch CALL on the node fast-path", async () => {
    const rows = Array.from({ length: 1100 }, (_, i) => ({ id: `n${i}` }));
    const g = makeGraphWithBatch();
    const events = makeCountingEvents();

    await writeNodeGroup(g, "Symbol", rows, () => {}, events);

    const calls = (g.createNodes as ReturnType<typeof vi.fn>).mock.calls;
    expect(events.counts.batch).toBe(calls.length);
    expect(events.counts.batch).toBe(Math.ceil(rows.length / DB_NODE_WRITE_BATCH_SIZE));
    expect(events.counts.split).toBe(0);
    expect(events.counts.oversized).toBe(0);
  });

  it("does NOT fire onBatch on the per-row fallback path", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `n${i}` }));
    const g = makeGraphNoBatch();
    const events = makeCountingEvents();

    await writeNodeGroup(g, "Symbol", rows, () => {}, events);

    expect(events.counts.batch).toBe(0);
  });

  it("fires onBatch per relationship batch call", async () => {
    const rows: RelationshipRow[] = Array.from({ length: 750 }, (_, i) => ({
      fromId: `a${i}`,
      toId: `b${i}`,
    }));
    const g = makeGraphWithBatch();
    const events = makeCountingEvents();

    await writeRelationshipGroup(g, "CONTAINS", rows, () => {}, events);

    expect(events.counts.batch).toBe(Math.ceil(rows.length / DB_RELATIONSHIP_WRITE_BATCH_SIZE));
  });

  it("fires onSplit on each adaptive-split halving (gRPC code 8) without changing row accuracy", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const v = makeVectorWithBatch();
      const indexSymbols = v.indexSymbols as ReturnType<typeof vi.fn>;
      // Reject any batch with more than 2 rows → forces splits of [4] → [2]+[2].
      indexSymbols.mockImplementation(async (part: readonly VectorEntry[]) => {
        if (part.length > 2) {
          throw Object.assign(new Error("too large"), { code: 8 });
        }
      });

      const entries: VectorEntry[] = Array.from({ length: 4 }, (_, i) => ({
        symbolId: `s${i}`,
        embedding: EMBEDDING,
      }));
      const events = makeCountingEvents();
      let counted = 0;

      await writeVectorEntries(v, entries, (n) => (counted += n), events);

      // One batch call dispatched, which split once into 2 + 2.
      expect(events.counts.batch).toBe(1);
      expect(events.counts.split).toBe(1);
      // Row accuracy preserved across the split.
      expect(counted).toBe(4);
    } finally {
      warn.mockRestore();
    }
  });

  it("fires onSplit multiple times for recursive halving", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const v = makeVectorWithBatch();
      const indexSymbols = v.indexSymbols as ReturnType<typeof vi.fn>;
      // Reject anything bigger than a single row → maximal splitting.
      indexSymbols.mockImplementation(async (part: readonly VectorEntry[]) => {
        if (part.length > 1) {
          throw Object.assign(new Error("too large"), { code: 8 });
        }
      });

      const entries: VectorEntry[] = Array.from({ length: 4 }, (_, i) => ({
        symbolId: `s${i}`,
        embedding: EMBEDDING,
      }));
      const events = makeCountingEvents();
      let counted = 0;

      await writeVectorEntries(v, entries, (n) => (counted += n), events);

      // [4] → split → [2]+[2]; each [2] → split → [1]+[1]. 3 split events total.
      expect(events.counts.split).toBe(3);
      expect(counted).toBe(4);
    } finally {
      warn.mockRestore();
    }
  });

  it("fires onOversized once per oversized row routed alone", async () => {
    const previous = process.env[GRPC_MAX_MESSAGE_BYTES_ENV];
    process.env[GRPC_MAX_MESSAGE_BYTES_ENV] = "120";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const budget = getRpcPayloadBudgetBytes();
      // One row whose serialized size alone exceeds the budget, plus small ones.
      const big = "x".repeat(budget * 2);
      const entries: VectorEntry[] = [
        { symbolId: "small-1", embedding: EMBEDDING },
        { symbolId: "huge", embedding: EMBEDDING, metadata: { big } },
        { symbolId: "small-2", embedding: EMBEDDING },
      ];
      const v = makeVectorWithBatch();
      const events = makeCountingEvents();

      await writeVectorEntries(v, entries, () => {}, events);

      expect(events.counts.oversized).toBe(1);
    } finally {
      warn.mockRestore();
      if (previous === undefined) {
        delete process.env[GRPC_MAX_MESSAGE_BYTES_ENV];
      } else {
        process.env[GRPC_MAX_MESSAGE_BYTES_ENV] = previous;
      }
    }
  });

  it("is fully optional — existing callers without events still work", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `n${i}` }));
    const g = makeGraphWithBatch();
    let counted = 0;
    await writeNodeGroup(g, "Symbol", rows, (n) => (counted += n));
    expect(counted).toBe(rows.length);
  });
});
