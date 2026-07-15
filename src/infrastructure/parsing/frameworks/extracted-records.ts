/**
 * Wave 6 — shared framework-extraction record shapes.
 *
 * These two records are the ground-truth, structured side-channel that framework
 * route/event extraction emits out of Phase 2. They are **shared with Wave 5**:
 * the data-touch detector consumes `ExtractedRoute[]` / `ExtractedEventSubscriber[]`
 * to emit `handlesRoute` / `subscribesTo` edges. Define them ONCE here.
 *
 * Both are PLAIN JSON (no native tree-sitter handles) so they cross the parse
 * `worker_threads` boundary via structured clone and round-trip through the
 * incremental parse cache unchanged.
 *
 * Provenance: ported from the legacy parser (typocop's pre-refactor parser
 * lineage). The field set is kept verbatim so the data-touch consumption logic
 * ports cleanly. `handlerNodeId` is produced with typocop's
 * `generateLogicalKey` / `generateSymbolId` (NOT the legacy id helper) so it
 * matches a persisted Method node's identity.
 */

/**
 * One extracted HTTP route, linked (where resolvable) to its controller method.
 *
 * @property httpMethod  Upper-cased verb (`GET`/`POST`/… or `ANY` for resources).
 * @property routePath   The route URI as written, or `null` when not a literal.
 * @property middleware  Effective middleware stack (group + chain), in order.
 * @property prefix      Effective group/chain path prefix, or `null`.
 * @property lineNumber  0-based source row of the route definition (tree-sitter).
 * @property handlerNodeId  Optional persisted Method-node key for the handler;
 *   only set by extractors that can resolve a concrete method (e.g. NestJS).
 */
export interface ExtractedRoute {
  filePath: string;
  httpMethod: string;
  routePath: string | null;
  controllerName: string | null;
  methodName: string | null;
  middleware: string[];
  prefix: string | null;
  lineNumber: number;
  handlerNodeId?: string;
}

/**
 * One extracted event/queue subscriber.
 *
 * @property topicName   Channel / queue / topic name the subscriber listens on.
 * @property framework   Producer label, e.g. `nestjs-event` / `nestjs-message` /
 *   `bullmq-processor` / `bullmq-workerhost` / `bullmq-consumer` /
 *   `bullmq-rabbitsubscribe`.
 * @property lineNumber  0-based source row of the subscriber (tree-sitter).
 */
export interface ExtractedEventSubscriber {
  filePath: string;
  topicName: string;
  className: string | null;
  methodName: string | null;
  framework: string;
  lineNumber: number;
}
