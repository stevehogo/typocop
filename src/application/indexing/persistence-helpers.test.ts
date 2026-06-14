/**
 * Tests for the batch-or-fallback persistence helpers (Phase D / PR7).
 *
 * Verifies the keystone invariant: behavior is IDENTICAL whether or not an
 * adapter implements the OPTIONAL batch methods —
 *   - same data written,
 *   - same grouping (single label / single type),
 *   - chunk sizes bounded by DB_WRITE_BATCH_SIZE on the batch path,
 *   - row-accurate counts (onRows totals === number of rows) on BOTH paths.
 */
import { describe, it, expect, vi } from "vitest";
import type { Embedding } from "../../core/domain.js";
import type { GraphAdapter, VectorAdapter } from "../../core/ports/persistence.js";
import { DB_WRITE_BATCH_SIZE } from "../../platform/utils/limits.js";
import {
  chunk,
  writeNodeGroup,
  writeRelationshipGroup,
  writeVectorEntries,
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
      expect(part.length).toBeLessThanOrEqual(DB_WRITE_BATCH_SIZE);
      seen.push(...part);
    }
    expect(seen).toEqual(rows);
    // Row-accurate: total counted equals rows, while batch CALLS are far fewer.
    expect(counted).toBe(rows.length);
    expect(calls.length).toBeLessThan(rows.length);
    expect(calls.length).toBe(Math.ceil(rows.length / DB_WRITE_BATCH_SIZE));
  });

  it("no-ops on empty input", async () => {
    const g = makeGraphWithBatch();
    let counted = 0;
    await writeNodeGroup(g, "Symbol", [], (n) => (counted += n));
    expect(g.createNodes).not.toHaveBeenCalled();
    expect(counted).toBe(0);
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
      expect(part.length).toBeLessThanOrEqual(DB_WRITE_BATCH_SIZE);
      seen.push(...part);
    }
    expect(seen).toEqual(rows);
    expect(counted).toBe(rows.length);
    expect(calls.length).toBe(Math.ceil(rows.length / DB_WRITE_BATCH_SIZE));
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
      expect(part.length).toBeLessThanOrEqual(DB_WRITE_BATCH_SIZE);
      seen.push(...part);
    }
    expect(seen).toEqual(entries);
    expect(counted).toBe(entries.length);
    expect(calls.length).toBe(Math.ceil(entries.length / DB_WRITE_BATCH_SIZE));
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
    const batchData = (batch.createNodes as ReturnType<typeof vi.fn>).mock.calls.flatMap(
      ([label, part]: [string, Array<Record<string, unknown>>]) =>
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
    const batchData = (batch.createRelationships as ReturnType<typeof vi.fn>).mock.calls.flatMap(
      ([type, part]: [string, RelationshipRow[]]) =>
        part.map((r) => ({ type, fromId: r.fromId, toId: r.toId, properties: r.properties })),
    );

    expect(batchData).toEqual(fallbackData);
  });
});
