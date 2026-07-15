/**
 * Wave 5 — DB read/write edge linking (Task 3).
 *
 * For every resolved `calls` edge whose callee NAME is in the curated read/write
 * method set, resolve which DB model the CALLER operates on (5 ranked strategies,
 * first hit wins) and emit a `readsFromDb`/`writesToDb` edge caller → model.
 *
 * Precision over recall: when no model resolves, NO edge is emitted (never a
 * guess). The single-model fallback (strategy 5) is the noisiest signal and is
 * gated behind `singleModelFallback` (default OFF).
 *
 * Ported from the legacy parser. Strategy 4 maps the legacy `getIncomingByType(
 * sourceId,'HAS_METHOD')` onto typocop's `Symbol.ownerId` (method→owner thread).
 * Strategy 3 reads `Symbol.signature` for the `Repository<Entity>` generic.
 */
import type { Symbol, Relationship } from "../../../core/domain.js";
import {
  DB_READ_METHODS,
  DB_WRITE_METHODS,
  makeDataTouchEdge,
  type DataTouchSink,
} from "./types.js";
import type { DbModelMap } from "./db-models.js";

export interface LinkDbOptions {
  /** Strategy 5: link a DB call to the sole model when exactly one exists.
   *  The noisiest heuristic — default OFF (precision over recall). */
  readonly singleModelFallback?: boolean;
}

/**
 * Emit `readsFromDb`/`writesToDb` edges by scanning `calls` edges for ORM
 * read/write method calls and resolving the caller's DB model.
 *
 * @param symbolsById  intra-run id → Symbol (callees/owners resolved by id).
 * @param relationships the resolved relationships (read-only; only `calls` scanned).
 * @param models       lower-cased table → model Symbol id (from db-models detection).
 */
export function linkDBOperations(
  symbolsById: ReadonlyMap<string, Symbol>,
  relationships: readonly Relationship[],
  models: DbModelMap,
  sink: DataTouchSink,
  options: LinkDbOptions = {},
): void {
  if (models.size === 0) return;
  const allModelIds = [...models.values()];

  // Build model-id → filePath for the same-file strategy.
  const modelFileById = new Map<string, string>();
  for (const [, modelId] of models) {
    const modelSym = symbolsById.get(modelId);
    if (modelSym) modelFileById.set(modelId, modelSym.location.filePath);
  }

  for (const rel of relationships) {
    if (rel.relType !== "calls") continue;
    const targetSym = symbolsById.get(rel.target);
    if (!targetSym) continue;

    const calledName = targetSym.name;
    const isRead = DB_READ_METHODS.has(calledName);
    const isWrite = DB_WRITE_METHODS.has(calledName);
    if (!isRead && !isWrite) continue;

    const sourceSym = symbolsById.get(rel.source);
    if (!sourceSym) continue;

    const sourceFile = sourceSym.location.filePath;
    const sourceName = sourceSym.name.toLowerCase();
    let matchedModelId: string | null = null;

    // Strategy 1: a DB model defined in the same file as the caller.
    for (const [, modelId] of models) {
      if (modelFileById.get(modelId) === sourceFile) {
        matchedModelId = modelId;
        break;
      }
    }

    // Strategy 2: caller name OR file path contains the table name.
    if (!matchedModelId) {
      for (const [tableName, modelId] of models) {
        if (sourceName.includes(tableName) || sourceFile.toLowerCase().includes(tableName)) {
          matchedModelId = modelId;
          break;
        }
      }
    }

    // Strategy 3: TypeORM `Repository<Entity>` generic in the caller signature.
    if (!matchedModelId) {
      const desc = sourceSym.signature ?? "";
      const repoMatch = desc.match(/Repository\s*<\s*(\w+)\s*>/);
      if (repoMatch) {
        const entityName = repoMatch[1].toLowerCase();
        matchedModelId = models.get(entityName) ?? null;
        if (!matchedModelId) {
          const stripped = entityName.replace(/entity$/, "");
          matchedModelId = models.get(stripped) ?? null;
        }
      }
    }

    // Strategy 4: parent class name (via `ownerId`) contains a table name.
    if (!matchedModelId && sourceSym.ownerId) {
      const ownerSym = symbolsById.get(sourceSym.ownerId);
      if (ownerSym) {
        const parentName = ownerSym.name.toLowerCase();
        for (const [tableName, modelId] of models) {
          if (parentName.includes(tableName)) {
            matchedModelId = modelId;
            break;
          }
        }
      }
    }

    // Strategy 5: single-model fallback — gated OFF by default (noisiest).
    if (!matchedModelId && options.singleModelFallback && allModelIds.length === 1) {
      matchedModelId = allModelIds[0];
    }

    if (!matchedModelId) continue; // precision over recall — refuse to guess.

    const relType = isRead ? "readsFromDb" : "writesToDb";
    sink.newRelationships.push(
      makeDataTouchEdge({
        relType,
        source: rel.source,
        target: matchedModelId,
        confidence: 0.7,
        reason: `db-${isRead ? "read" : "write"}-${calledName}`,
        idSuffix: calledName,
      }),
    );
    sink.counters.dbEdges++;
  }
}
