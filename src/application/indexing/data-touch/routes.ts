/**
 * Wave 5 — route handler linking (Task 4).
 *
 * `detectAPIEndpointsFromNodes`: links route-handler method/function Symbols to
 * the HTTP endpoint they serve via `handlesRoute` edges, using decorator text on
 * the method signature (`@Get('/x')`, `@GetMapping("/x")`) with controller
 * base-path composition (via `Symbol.ownerId` → owner class `@Controller('base')`).
 *
 * `detectExpressStyleRoutes`: detects Express/Fastify/Koa `app.get('/x', h)` /
 * `router.post(...)` registrations from `calls` edges into `get`/`post`/… in
 * route/controller files.
 *
 * Both mint a synthetic `apiendpoint:<METHOD>:<path>` Symbol when no framework
 * route Symbol exists, and honour an `alreadyLinked` defer set so the regex
 * fallback never double-links a handler a structured extractor (Wave 6) linked.
 *
 * Ported from the legacy parser; decorator/route text is read from
 * `Symbol.signature` (typocop has no `description` field) and the controller
 * base-path walk uses `Symbol.ownerId` (not a `HAS_METHOD` edge).
 */
import type { Symbol, Relationship } from "../../../core/domain.js";
import {
  ROUTE_DECORATORS,
  CONTROLLER_DECORATORS,
  CONTROLLER_FILE_PATTERNS,
  EXPRESS_ROUTE_METHODS,
  API_ENDPOINT_ID_PREFIX,
  normalizePath,
  makeSyntheticSymbol,
  makeDataTouchEdge,
  type DataTouchSink,
} from "./types.js";

/**
 * Pre-seed `alreadyLinked` with the source ids of every existing `handlesRoute`
 * edge so the heuristic detectors defer to structured extractors (Wave 6 seam).
 */
export function collectAlreadyLinked(relationships: readonly Relationship[]): Set<string> {
  const linked = new Set<string>();
  for (const rel of relationships) {
    if (rel.relType === "handlesRoute") linked.add(rel.source);
  }
  return linked;
}

/**
 * Return the endpoint Symbol id for `<httpMethod> <fullPath>`, reusing an existing
 * framework route Symbol with that identity when present (Wave 6), else minting a
 * synthetic `apiendpoint:<METHOD>:<path>` Symbol.
 */
function ensureEndpoint(
  httpMethod: string,
  fullPath: string,
  filePath: string,
  startLine: number,
  endpointsByKey: Map<string, string>,
  sink: DataTouchSink,
): string {
  const key = `${httpMethod}:${fullPath}`;
  const existing = endpointsByKey.get(key);
  if (existing) return existing;

  const endpointId = `${API_ENDPOINT_ID_PREFIX}${key}`;
  sink.newSymbols.push(
    makeSyntheticSymbol({
      id: endpointId,
      name: `${httpMethod} ${fullPath}`,
      kind: "function",
      filePath,
      startLine,
    }),
  );
  endpointsByKey.set(key, endpointId);
  sink.counters.apiEndpoints++;
  return endpointId;
}

/**
 * NestJS/Spring decorator-regex route detection over `Symbol.signature`, with
 * controller base-path composition via `ownerId`.
 */
export function detectAPIEndpointsFromNodes(
  symbols: readonly Symbol[],
  symbolsById: ReadonlyMap<string, Symbol>,
  alreadyLinked: Set<string>,
  sink: DataTouchSink,
): void {
  // Phase A — controller base paths (classNodeId → basePath).
  const controllerPaths = new Map<string, string>();
  for (const sym of symbols) {
    if (sym.kind !== "class" || sym.synthetic) continue;
    const desc = sym.signature ?? "";
    const name = sym.name;
    const filePath = sym.location.filePath;

    let isController = false;
    for (const decorator of CONTROLLER_DECORATORS) {
      if (desc.includes(`@${decorator}`) || desc.includes(decorator)) {
        isController = true;
        break;
      }
    }
    if (!isController && name.endsWith("Controller")) isController = true;
    if (!isController) {
      for (const pattern of CONTROLLER_FILE_PATTERNS) {
        if (pattern.test(filePath)) {
          isController = true;
          break;
        }
      }
    }

    if (isController) {
      const pathMatch = desc.match(/@(?:Controller|RestController|RequestMapping)\s*\(\s*['"]([^'"]*)['"]\s*\)/);
      controllerPaths.set(sym.id, pathMatch ? `/${pathMatch[1]}` : "");
    }
  }

  // Endpoint key → endpoint Symbol id (synthetic anchors are deduped per key).
  const endpointsByKey = new Map<string, string>();

  // Phase C — match handler methods.
  for (const sym of symbols) {
    if (sym.kind !== "method" && sym.kind !== "function") continue;
    if (sym.synthetic) continue;
    if (alreadyLinked.has(sym.id)) continue; // defer to structured extractor.
    const desc = sym.signature ?? "";

    for (const [decorator, httpMethod] of Object.entries(ROUTE_DECORATORS)) {
      const regexWithParens = new RegExp(`@${decorator}\\s*\\(\\s*['"]([^'"\\)]*?)['"]\\s*\\)`, "i");
      const regexEmptyParens = new RegExp(`@${decorator}\\s*\\(\\s*\\)`, "i");
      const regexNoParens = new RegExp(`@${decorator}(?:\\s|$|\\n)`, "i");

      const matchWithPath = desc.match(regexWithParens);
      const matchEmpty = regexEmptyParens.test(desc);
      const matchNoParens = regexNoParens.test(desc);

      if (matchWithPath || matchEmpty || matchNoParens) {
        const routePath = matchWithPath?.[1] ?? "";

        // Controller base path via ownerId.
        let basePath = "";
        if (sym.ownerId) basePath = controllerPaths.get(sym.ownerId) ?? "";

        const fullPath = normalizePath(basePath, routePath);
        const endpointId = ensureEndpoint(
          httpMethod,
          fullPath,
          sym.location.filePath,
          sym.location.startLine,
          endpointsByKey,
          sink,
        );

        sink.newRelationships.push(
          makeDataTouchEdge({
            relType: "handlesRoute",
            source: sym.id,
            target: endpointId,
            confidence: 0.85,
            reason: `decorator-${decorator}`,
          }),
        );
        sink.counters.routeEdges++;
        alreadyLinked.add(sym.id); // don't double-link in detectExpressStyleRoutes.
        break; // only the first matching decorator per method.
      }
    }
  }

  // Stash the per-run endpoint map so the express pass dedupes against it too.
  endpointMapCarrier.set(sink, endpointsByKey);
}

/**
 * Express/Fastify/Koa-style route detection from `calls` edges into get/post/…
 * methods. Reads the registration path from the caller's `Symbol.signature`.
 */
export function detectExpressStyleRoutes(
  symbolsById: ReadonlyMap<string, Symbol>,
  relationships: readonly Relationship[],
  alreadyLinked: Set<string>,
  sink: DataTouchSink,
): void {
  const endpointsByKey = endpointMapCarrier.get(sink) ?? new Map<string, string>();

  for (const rel of relationships) {
    if (rel.relType !== "calls") continue;
    const targetSym = symbolsById.get(rel.target);
    if (!targetSym) continue;

    const calledName = targetSym.name;
    if (!EXPRESS_ROUTE_METHODS.has(calledName)) continue;

    const sourceSym = symbolsById.get(rel.source);
    if (!sourceSym) continue;
    if (alreadyLinked.has(rel.source)) continue; // defer to structured / decorator.

    const desc = sourceSym.signature ?? "";
    const filePath = sourceSym.location.filePath;

    // Route-file gate, else require an app/router/server/fastify.<method>( in sig.
    const isRouteFile = CONTROLLER_FILE_PATTERNS.some((p) => p.test(filePath));
    if (!isRouteFile) {
      const expressPattern = new RegExp(`(?:app|router|server|fastify)\\s*\\.\\s*${calledName}\\s*\\(`, "i");
      if (!expressPattern.test(desc)) continue;
    }

    const pathMatch = desc.match(
      new RegExp(`\\.${calledName}\\s*\\(\\s*['"\`](\\/[^'"\`]*?)['"\`]`, "i"),
    );
    const routePath = pathMatch?.[1] ?? `/${calledName}`;
    const httpMethod = calledName.toUpperCase();

    // Skip pathless use/all (use isn't in the method set; all is reachable).
    if ((calledName === "use" || calledName === "all") && !pathMatch) continue;

    const endpointId = ensureEndpoint(
      httpMethod,
      routePath,
      filePath,
      sourceSym.location.startLine,
      endpointsByKey,
      sink,
    );

    sink.newRelationships.push(
      makeDataTouchEdge({
        relType: "handlesRoute",
        source: rel.source,
        target: endpointId,
        confidence: 0.7,
        reason: `express-${calledName}`,
      }),
    );
    sink.counters.routeEdges++;
    alreadyLinked.add(rel.source);
  }
}

/**
 * Per-sink scratch map sharing the endpoint dedup table between the decorator and
 * express passes (a `WeakMap` so it is GC'd with the sink — no global state).
 */
const endpointMapCarrier = new WeakMap<DataTouchSink, Map<string, string>>();
