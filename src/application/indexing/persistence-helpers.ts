/**
 * Batch-or-fallback persistence helpers for the indexing pipeline (Phase D).
 *
 * The port interfaces expose OPTIONAL batch methods
 * (`GraphAdapter.createNodes` / `createRelationships`,
 * `VectorAdapter.indexSymbols`). These helpers route a pre-grouped collection
 * of writes through the batch fast-path WHEN the adapter implements it, and
 * fall back to the existing per-row methods otherwise. The chosen path is
 * transparent: the same data is written, with the same grouping (a single
 * label for nodes, a single type for relationships), and the per-row metric
 * counts stay row-accurate on BOTH paths — the batch path increments by
 * `chunk.length`, not by one per batch call.
 *
 * Prefix behavior remains adapter-owned: these helpers never prepend a prefix.
 */
import type { Embedding } from "../../core/domain.js";
import type { GraphAdapter, VectorAdapter } from "../../core/ports/persistence.js";
import { DB_WRITE_BATCH_SIZE } from "../../platform/utils/limits.js";

/** A relationship row sharing a single type. */
export interface RelationshipRow {
  readonly fromId: string;
  readonly toId: string;
  readonly properties?: Record<string, unknown>;
}

/** A vector-index entry. */
export interface VectorEntry {
  readonly symbolId: string;
  readonly embedding: Embedding;
  readonly metadata?: Record<string, string>;
}

/**
 * Split `items` into consecutive chunks of at most `size` elements. The union
 * of chunks (in order) equals `items`; each chunk is non-empty; the last chunk
 * may be smaller. An empty input yields no chunks.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error(`chunk size must be positive, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Write all `rows` for a single node `label`. Uses `graphAdapter.createNodes`
 * (chunked by DB_WRITE_BATCH_SIZE) when present, else loops `createNode`.
 * `onRows(n)` is invoked with the row count actually written per chunk/row so
 * callers can keep metric counts row-accurate on either path.
 */
export async function writeNodeGroup(
  graphAdapter: GraphAdapter,
  label: string,
  rows: ReadonlyArray<Record<string, unknown>>,
  onRows: (count: number) => void,
): Promise<void> {
  if (rows.length === 0) return;
  if (graphAdapter.createNodes) {
    for (const part of chunk(rows, DB_WRITE_BATCH_SIZE)) {
      await graphAdapter.createNodes(label, part);
      onRows(part.length);
    }
    return;
  }
  for (const row of rows) {
    await graphAdapter.createNode(label, row);
    onRows(1);
  }
}

/**
 * Write all `rows` for a single relationship `type`. Uses
 * `graphAdapter.createRelationships` (chunked by DB_WRITE_BATCH_SIZE) when
 * present, else loops `createRelationship`. `onRows` keeps counts row-accurate.
 */
export async function writeRelationshipGroup(
  graphAdapter: GraphAdapter,
  type: string,
  rows: readonly RelationshipRow[],
  onRows: (count: number) => void,
): Promise<void> {
  if (rows.length === 0) return;
  if (graphAdapter.createRelationships) {
    for (const part of chunk(rows, DB_WRITE_BATCH_SIZE)) {
      await graphAdapter.createRelationships(type, part);
      onRows(part.length);
    }
    return;
  }
  for (const row of rows) {
    await graphAdapter.createRelationship(row.fromId, row.toId, type, row.properties);
    onRows(1);
  }
}

/**
 * Write all vector `entries`. Uses `vectorAdapter.indexSymbols` (chunked by
 * DB_WRITE_BATCH_SIZE) when present, else loops `indexSymbol`. `onRows` keeps
 * counts row-accurate.
 */
export async function writeVectorEntries(
  vectorAdapter: VectorAdapter,
  entries: readonly VectorEntry[],
  onRows: (count: number) => void,
): Promise<void> {
  if (entries.length === 0) return;
  if (vectorAdapter.indexSymbols) {
    for (const part of chunk(entries, DB_WRITE_BATCH_SIZE)) {
      await vectorAdapter.indexSymbols(part);
      onRows(part.length);
    }
    return;
  }
  for (const entry of entries) {
    await vectorAdapter.indexSymbol(entry.symbolId, entry.embedding, entry.metadata);
    onRows(1);
  }
}
