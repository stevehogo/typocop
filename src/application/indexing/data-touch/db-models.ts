/**
 * Wave 5 — DB model detection (Task 2).
 *
 * `detectDBModels`: identifies which existing class/interface Symbols are DB
 * models (ORM decorator text, `*Entity`/`*Model`/`*Schema`/`*Document` name
 * suffix, or `models/`/`entities/`/`schemas/` path) and records `table → symbolId`.
 *
 * `detectPrismaModels`: scans method/function signatures for `prisma.<model>.<op>`
 * and, for each model (which has no class Symbol), MINTS a synthetic
 * `dbmodel:<table>` Symbol + a read/write edge.
 *
 * Ported from the legacy parser. Where the legacy code read
 * `node.properties.description`, typocop reads `Symbol.signature` (decorator /
 * heritage text lives there — `@Entity(...)`, `extends Model`). FLAG-DESC: the
 * legacy parser also crammed raw Prisma CALL text into `description`; typocop's
 * `signature` is the callable signature, so `detectPrismaModels` over `signature`
 * fires only when the `prisma.x.find()` text appears in the signature (e.g. an
 * arrow/lambda body captured into the signature) — it is a best-effort heuristic
 * until a raw-call-text carrier exists.
 */
import type { Symbol } from "../../../core/domain.js";
import {
  DB_MODEL_PATTERNS,
  PRISMA_MODEL_PATTERN,
  DB_MODEL_ID_PREFIX,
  makeSyntheticSymbol,
  makeDataTouchEdge,
  type DataTouchSink,
} from "./types.js";

/** Resolved DB models: lower-cased table name → the (real or synthetic) model Symbol id. */
export type DbModelMap = Map<string, string>;

/**
 * Detect DB-model class/interface Symbols and record `table → symbolId`. Real
 * class Symbols are reused as the model endpoint — NO synthetic Symbol is minted
 * here (only Prisma needs synthesis). Mutates `models` in place; the legacy
 * `DEFINES` class→model edge is intentionally dropped (the class IS the model).
 */
export function detectDBModels(symbols: readonly Symbol[], models: DbModelMap): void {
  for (const sym of symbols) {
    if (sym.kind !== "class" && sym.kind !== "interface") continue;
    if (sym.synthetic) continue;
    const desc = sym.signature ?? "";
    const name = sym.name;
    const filePath = sym.location.filePath;

    let isModel = false;
    let tableName = "";

    // (a) ORM decorator/keyword text in the signature.
    for (const pattern of DB_MODEL_PATTERNS) {
      if (desc.includes(`@${pattern}`) || desc.includes(pattern)) {
        isModel = true;
        const tableMatch = desc.match(/@(?:Entity|Table)\s*\(\s*['"]([^'"]+)['"]\s*\)/);
        tableName = tableMatch ? tableMatch[1] : name.toLowerCase();
        break;
      }
    }

    // (b) name suffix Entity/Model/Schema/Document.
    if (!isModel && /(?:Entity|Model|Schema|Document)$/.test(name)) {
      isModel = true;
      tableName = name.replace(/(?:Entity|Model|Schema|Document)$/, "").toLowerCase();
    }

    // (c) file-path directory models/ entities/ schemas/.
    if (!isModel) {
      const modelFilePatterns = [/models?\//i, /entities?\//i, /schemas?\//i];
      for (const pat of modelFilePatterns) {
        if (pat.test(filePath)) {
          isModel = true;
          tableName = name.toLowerCase();
          break;
        }
      }
    }

    if (isModel) {
      const table = (tableName || name).toLowerCase();
      // First definition wins (a later same-table class does not clobber it).
      if (!models.has(table)) models.set(table, sym.id);
    }
  }
}

/**
 * Detect Prisma model usage in method/function signatures and synthesize a
 * `dbmodel:<table>` Symbol + read/write edge per match. Appends synthetic Symbols
 * + edges to `sink` and registers each table in `models`.
 */
export function detectPrismaModels(
  symbols: readonly Symbol[],
  models: DbModelMap,
  sink: DataTouchSink,
): void {
  for (const sym of symbols) {
    if (sym.kind !== "method" && sym.kind !== "function") continue;
    if (sym.synthetic) continue;
    const desc = sym.signature ?? "";
    if (!desc) continue;

    PRISMA_MODEL_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PRISMA_MODEL_PATTERN.exec(desc)) !== null) {
      const modelName = match[1].toLowerCase();
      const methodName = match[2];

      if (modelName.startsWith("$") || modelName === "transaction") continue;

      const modelId = ensureSyntheticModel(modelName, sym.location.filePath, models, sink);

      const isRead =
        methodName.startsWith("find") ||
        methodName === "count" ||
        methodName === "aggregate" ||
        methodName === "groupBy";
      const relType = isRead ? "readsFromDb" : "writesToDb";

      sink.newRelationships.push(
        makeDataTouchEdge({
          relType,
          source: sym.id,
          target: modelId,
          confidence: 0.85,
          reason: `prisma-${methodName}`,
          idSuffix: `prisma.${methodName}`,
        }),
      );
      sink.counters.dbEdges++;
    }
  }
}

/**
 * Return the model Symbol id for `tableName`, minting a synthetic `dbmodel:<table>`
 * Symbol on first sight. Reused by Prisma detection (and available to the
 * single-model fallback path) so a table never gets two anchor Symbols.
 */
export function ensureSyntheticModel(
  tableName: string,
  filePath: string,
  models: DbModelMap,
  sink: DataTouchSink,
): string {
  const existing = models.get(tableName);
  if (existing) return existing;

  const modelId = `${DB_MODEL_ID_PREFIX}${tableName}`;
  sink.newSymbols.push(
    makeSyntheticSymbol({ id: modelId, name: tableName, kind: "class", filePath }),
  );
  models.set(tableName, modelId);
  sink.counters.dbModels++;
  return modelId;
}
