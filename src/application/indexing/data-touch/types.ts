/**
 * Wave 5 — data-touch detection: shared constants, types, and helpers.
 *
 * Ported from the legacy parser's data-touch detector (typocop's pre-refactor
 * parser lineage). The legacy detector ran over an in-memory property graph with
 * a free-form `node.properties.description` string and `HAS_METHOD` edges; typocop
 * runs over `Symbol[]` + `Relationship[]`, so the port:
 *   - sources decorator / heritage / ORM text from `Symbol.signature` (typocop has
 *     no `description` field) — and therefore cannot run the detectors that the
 *     legacy parser drove off raw call-text it stuffed into `description`;
 *   - threads method→owner via `Symbol.ownerId` (not a `HAS_METHOD` edge);
 *   - emits typocop's lowercase `RelationType` members (`readsFromDb`/`writesToDb`/
 *     `handlesRoute`/`publishesEvent`/`subscribesTo`) with `confidence`/`reason`
 *     carried as STRINGS in `Relationship.metadata`.
 *
 * The detection pass is purely additive and flag-gated (`PipelineConfig.dataTouch`,
 * default OFF); when off it never runs and the graph is byte-identical.
 */
import type { Symbol, Relationship, RelationType, SymbolKind } from "../../../core/domain.js";

// ─── ID / tag conventions ──────────────────────────────────────────────────────

/** Namespaced id prefix for a synthetic DB-model Symbol (`dbmodel:<table>`). */
export const DB_MODEL_ID_PREFIX = "dbmodel:";
/** Namespaced id prefix for a synthetic API-endpoint Symbol (`apiendpoint:<METHOD>:<path>`). */
export const API_ENDPOINT_ID_PREFIX = "apiendpoint:";
/** Namespaced id prefix for a synthetic event-channel Symbol (`eventchannel:<name>`). */
export const EVENT_CHANNEL_ID_PREFIX = "eventchannel:";

// ─── Configuration constants (ported verbatim) ─────────────────────────────────

/**
 * Framework route-decorator name → HTTP method. Keys are decorator names (NestJS +
 * Spring Boot), values are HTTP verbs — NOT relTypes.
 */
export const ROUTE_DECORATORS: Record<string, string> = {
  // NestJS
  Get: "GET", Post: "POST", Put: "PUT", Patch: "PATCH",
  Delete: "DELETE", Options: "OPTIONS", Head: "HEAD", All: "ALL",
  // Spring Boot
  GetMapping: "GET", PostMapping: "POST", PutMapping: "PUT",
  DeleteMapping: "DELETE", PatchMapping: "PATCH", RequestMapping: "ANY",
};

/** Decorator names that indicate a controller class. */
export const CONTROLLER_DECORATORS = new Set(["Controller", "RestController", "ApiController"]);

/** File-path patterns that indicate a controller / route file. */
export const CONTROLLER_FILE_PATTERNS: readonly RegExp[] = [
  /\.controller\./i,
  /controllers?\//i,
  /Controller\./i,
  /\.routes?\./i,
  /routes?\//i,
];

/** Express/Fastify/Koa HTTP method names used in route registration. */
export const EXPRESS_ROUTE_METHODS = new Set([
  "get", "post", "put", "patch", "delete", "all", "options", "head",
]);

/** Class decorator / keyword patterns that indicate a DB model. */
export const DB_MODEL_PATTERNS = new Set([
  "Entity", "Table", "Schema", "Model",
  "model", "Document", // Mongoose
  "PrismaClient",
]);

/** Method names indicating DB reads. */
export const DB_READ_METHODS = new Set([
  "find", "findOne", "findMany", "findAll", "findById", "findByPk",
  "findFirst", "findUnique", "findOrFail",
  "get", "getOne", "getMany",
  "query", "select", "count", "aggregate",
  "where", "paginate",
  "findAndCount", "findAndCountAll",
]);

/** Method names indicating DB writes. */
export const DB_WRITE_METHODS = new Set([
  "save", "create", "insert", "update", "upsert", "delete", "remove",
  "createMany", "updateMany", "deleteMany",
  "persist", "merge", "softDelete", "restore",
  "bulkCreate", "bulkInsert",
  "increment", "decrement",
]);

/** Method / decorator patterns for event publishing. */
export const EVENT_PUBLISH_PATTERNS = new Set([
  "emit", "publish", "send", "dispatch", "broadcast",
  "sendToQueue", "publishEvent", "add", "enqueue",
]);

/** Decorator / method patterns for event subscribing. */
export const EVENT_SUBSCRIBE_PATTERNS = new Set([
  "EventPattern", "MessagePattern", "OnEvent", "Subscribe",
  "on", "addEventListener", "listen", "handle",
  "Process", "Processor", "Consumer",
]);

/**
 * Prisma method pattern: `prisma.user.findMany()` etc. Global + case-insensitive;
 * callers MUST reset `.lastIndex = 0` before each independent scan.
 * group 1 = model name, group 2 = method.
 */
export const PRISMA_MODEL_PATTERN = /\bprisma\.(\w+)\.(find\w*|create\w*|update\w*|delete\w*|upsert|count|aggregate|groupBy)\b/gi;

// ─── Shared result / mutation types ─────────────────────────────────────────────

/** Counters returned by the detection helpers (parity with the legacy result). */
export interface DataTouchCounters {
  apiEndpoints: number;
  dbModels: number;
  eventChannels: number;
  routeEdges: number;
  dbEdges: number;
  eventEdges: number;
}

export function emptyCounters(): DataTouchCounters {
  return { apiEndpoints: 0, dbModels: 0, eventChannels: 0, routeEdges: 0, dbEdges: 0, eventEdges: 0 };
}

/**
 * Mutable sink the detectors append to. `symbols`/`relationships` are the
 * additive new Symbols (synthetic anchors) and edges; `counters` accumulate.
 * The caller seeds it with the already-emitted relationships so detectors can
 * read the resolved `calls` graph and honour the `alreadyLinked` defer set.
 */
export interface DataTouchSink {
  readonly newSymbols: Symbol[];
  readonly newRelationships: Relationship[];
  readonly counters: DataTouchCounters;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Join a non-empty prefix + path with `/`, strip leading slashes, collapse
 * repeated slashes, then re-prepend a single `/`. Ported verbatim.
 */
export function normalizePath(prefix: string | null | undefined, path: string | null | undefined): string {
  const parts = [prefix, path].filter(Boolean).join("/");
  return "/" + parts.replace(/^\/+/, "").replace(/\/+/g, "/");
}

/**
 * Build a synthetic Symbol used as a data-touch edge anchor. `id === logicalKey`
 * (the namespaced id is already a stable, position-independent identity), so it
 * round-trips through `persistedKey`/`keyOf` to the same string. Tagged
 * `synthetic:true` so it is excluded from clustering + search.
 */
export function makeSyntheticSymbol(opts: {
  id: string;
  name: string;
  kind: SymbolKind;
  filePath: string;
  startLine?: number;
}): Symbol {
  return {
    id: opts.id,
    logicalKey: opts.id,
    name: opts.name,
    kind: opts.kind,
    location: {
      filePath: opts.filePath,
      startLine: opts.startLine ?? 0,
      startColumn: 0,
      endLine: opts.startLine ?? 0,
      endColumn: 0,
    },
    visibility: "public",
    modifiers: [],
    synthetic: true,
  };
}

/**
 * Build a data-touch Relationship with `confidence`/`reason` carried as STRINGS in
 * `metadata` (the only place edge props persist; the adapter allow-list keeps just
 * `confidence`/`reason`). `id` mirrors the legacy `relType:source->target` scheme.
 */
export function makeDataTouchEdge(opts: {
  relType: RelationType;
  source: string;
  target: string;
  confidence: number;
  reason: string;
  /** Extra discriminator folded into the edge id to avoid collapsing distinct
   *  same-pair edges (e.g. the called method name). */
  idSuffix?: string;
}): Relationship {
  const suffix = opts.idSuffix ? `:${opts.idSuffix}` : "";
  return {
    id: `${opts.relType}:${opts.source}->${opts.target}${suffix}`,
    source: opts.source,
    target: opts.target,
    relType: opts.relType,
    metadata: { confidence: String(opts.confidence), reason: opts.reason },
  };
}

/**
 * Index symbols by intra-run `id`. The data-touch detectors resolve callees /
 * owners by id (the `calls` edges reference ids), distinct from the name-keyed
 * `buildSymbolMap` used by the resolvers.
 */
export function indexById(symbols: readonly Symbol[]): Map<string, Symbol> {
  const map = new Map<string, Symbol>();
  for (const sym of symbols) map.set(sym.id, sym);
  return map;
}
