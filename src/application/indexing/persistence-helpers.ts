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
import {
  DB_NODE_WRITE_BATCH_SIZE,
  DB_RELATIONSHIP_WRITE_BATCH_SIZE,
  DB_VECTOR_WRITE_BATCH_SIZE,
  getRpcPayloadBudgetBytes,
} from "../../platform/utils/limits.js";

const JSON_ARRAY_OVERHEAD_BYTES = 2;
const JSON_ARRAY_SEPARATOR_BYTES = 1;
const RESOURCE_EXHAUSTED_GRPC_CODE = 8;

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
 * Optional batch-level event callbacks (Phase B).
 *
 * These mirror the existing `onRows` pattern so the pipeline can observe
 * batch/split/oversized events WITHOUT this module importing the metrics layer.
 * All callbacks are fire-and-forget and carry no payload — counts/timings only.
 *
 * - `onBatch`  fires once per batch CALL on the batch fast-path. It does NOT
 *   fire on the per-row fallback path (there are no batches there).
 * - `onSplit`  fires once per halving decision inside writeWithAdaptiveSplit
 *   (which recurses; each split event is counted).
 * - `onOversized` fires from chunkByBudget's onOversizedItem hook, once per
 *   oversized row routed alone.
 */
export interface PersistEvents {
  readonly onBatch?: () => void;
  readonly onSplit?: () => void;
  readonly onOversized?: () => void;
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

export interface ChunkByBudgetOptions<T> {
  readonly maxBytes: number;
  readonly maxCount: number;
  readonly sizeOf: (item: T) => number;
  readonly onOversizedItem?: (item: T, sizeBytes: number, maxBytes: number) => void;
}

/**
 * Split `items` into consecutive chunks bounded by both serialized byte budget
 * and row count. The byte accounting matches JSON array payloads:
 * `[item,item]` = array overhead + item sizes + comma separators.
 */
export function chunkByBudget<T>(
  items: readonly T[],
  options: ChunkByBudgetOptions<T>,
): T[][] {
  if (options.maxBytes <= JSON_ARRAY_OVERHEAD_BYTES) {
    throw new Error(`maxBytes must be greater than ${JSON_ARRAY_OVERHEAD_BYTES}, got ${options.maxBytes}`);
  }
  if (options.maxCount <= 0) {
    throw new Error(`maxCount must be positive, got ${options.maxCount}`);
  }

  const out: T[][] = [];
  let current: T[] = [];
  let currentBytes = JSON_ARRAY_OVERHEAD_BYTES;

  const flush = (): void => {
    if (current.length === 0) return;
    out.push(current);
    current = [];
    currentBytes = JSON_ARRAY_OVERHEAD_BYTES;
  };

  for (const item of items) {
    const itemBytes = Math.ceil(options.sizeOf(item));
    if (!Number.isFinite(itemBytes) || itemBytes < 0) {
      throw new Error(`sizeOf must return a non-negative finite number, got ${itemBytes}`);
    }

    const oversizedItemBytes = JSON_ARRAY_OVERHEAD_BYTES + itemBytes;
    if (oversizedItemBytes > options.maxBytes) {
      flush();
      options.onOversizedItem?.(item, oversizedItemBytes, options.maxBytes);
      out.push([item]);
      continue;
    }

    const separatorBytes = current.length === 0 ? 0 : JSON_ARRAY_SEPARATOR_BYTES;
    const wouldExceedBytes = currentBytes + separatorBytes + itemBytes > options.maxBytes;
    const wouldExceedCount = current.length >= options.maxCount;
    if (wouldExceedBytes || wouldExceedCount) {
      flush();
    }

    const nextSeparatorBytes = current.length === 0 ? 0 : JSON_ARRAY_SEPARATOR_BYTES;
    current.push(item);
    currentBytes += nextSeparatorBytes + itemBytes;
  }

  flush();
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
  events?: PersistEvents,
): Promise<void> {
  if (rows.length === 0) return;
  if (graphAdapter.createNodes) {
    for (const part of chunkBatchPayload(rows, DB_NODE_WRITE_BATCH_SIZE, "node", events)) {
      events?.onBatch?.();
      await writeWithAdaptiveSplit(
        part,
        (batch) => graphAdapter.createNodes!(label, batch),
        `Graph.CreateNodes(${label})`,
        events,
      );
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
  events?: PersistEvents,
): Promise<void> {
  if (rows.length === 0) return;
  if (graphAdapter.createRelationships) {
    for (const part of chunkBatchPayload(rows, DB_RELATIONSHIP_WRITE_BATCH_SIZE, "relationship", events)) {
      events?.onBatch?.();
      await writeWithAdaptiveSplit(
        part,
        (batch) => graphAdapter.createRelationships!(type, batch),
        `Graph.CreateRelationships(${type})`,
        events,
      );
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
  events?: PersistEvents,
): Promise<void> {
  if (entries.length === 0) return;
  if (vectorAdapter.indexSymbols) {
    for (const part of chunkBatchPayload(entries, DB_VECTOR_WRITE_BATCH_SIZE, "vector entry", events)) {
      events?.onBatch?.();
      await writeWithAdaptiveSplit(
        part,
        (batch) => vectorAdapter.indexSymbols!(batch),
        "Vector.IndexSymbols",
        events,
      );
      onRows(part.length);
    }
    return;
  }
  for (const entry of entries) {
    await vectorAdapter.indexSymbol(entry.symbolId, entry.embedding, entry.metadata);
    onRows(1);
  }
}

function chunkBatchPayload<T>(
  items: readonly T[],
  maxCount: number,
  itemName: string,
  events?: PersistEvents,
): T[][] {
  return chunkByBudget(items, {
    maxBytes: getRpcPayloadBudgetBytes(),
    maxCount,
    sizeOf: serializedJsonLength,
    onOversizedItem: (_item, sizeBytes, maxBytes) => {
      events?.onOversized?.();
      console.warn(
        `[pipeline] ${itemName} serialized size ${sizeBytes} bytes exceeds RPC payload budget ${maxBytes} bytes; sending it alone`,
      );
    },
  });
}

async function writeWithAdaptiveSplit<T>(
  items: readonly T[],
  write: (batch: readonly T[]) => Promise<void>,
  context: string,
  events?: PersistEvents,
): Promise<void> {
  try {
    await write(items);
  } catch (error) {
    if (!isResourceExhaustedError(error)) {
      throw error;
    }
    if (items.length <= 1) {
      throw new Error(
        `${context} failed because a single row exceeds the configured gRPC message limit`,
        { cause: error },
      );
    }

    events?.onSplit?.();
    const midpoint = Math.floor(items.length / 2);
    console.warn(
      `[pipeline] ${context} exceeded the gRPC message limit; retrying as ${midpoint} + ${items.length - midpoint} rows`,
    );
    await writeWithAdaptiveSplit(items.slice(0, midpoint), write, context, events);
    await writeWithAdaptiveSplit(items.slice(midpoint), write, context, events);
  }
}

function isResourceExhaustedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (error as { readonly code?: unknown }).code === RESOURCE_EXHAUSTED_GRPC_CODE;
}

function serializedJsonLength(value: unknown): number {
  return JSON.stringify(value).length;
}
