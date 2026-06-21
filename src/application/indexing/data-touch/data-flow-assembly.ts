/**
 * Wave 5 — DataFlow assembly (Task 5).
 *
 * BFS from each data entry point (route handler, event channel, or high-score
 * function) over `{calls, readsFromDb, writesToDb, publishesEvent, subscribesTo}`
 * edges whose `Number(metadata.confidence) >= MIN_CONFIDENCE`, assembling each
 * path into a named flow (`GET /users -> users`), deduping (prefer DB-touching,
 * then longer), and anchoring non-handler entry points back to an HTTP endpoint
 * via reverse-`calls` (`findCallerWithRoute`).
 *
 * `handlesRoute` is DELIBERATELY EXCLUDED from the BFS edge set: including it
 * causes BFS to jump from a controller method → sibling APIEndpoint anchors in
 * the same controller, producing nonsensical flows. The endpoint is instead
 * resolved from the entry point's OWN `handlesRoute` edge (the `handlerToAPI`
 * map below).
 *
 * Ported from the legacy parser's data-flow-processor, adapted onto typocop's
 * model:
 *   - adjacency is built over `Relationship[]` (filtered by `relType` +
 *     `Number(metadata.confidence) >= 0.5`) instead of an in-memory property
 *     graph's `getOutgoing`;
 *   - the output maps onto typocop's existing `Process` shape — `Process.name =
 *     "GET /users -> users"`, `entryPoint`, `steps: ProcessStep[]`, `dataFlow:
 *     DataFlowEdge[]` — so flows REUSE the `Process`/`HAS_STEP` persistence path;
 *     NO `DataFlow` node label is introduced;
 *   - the LLM flow-enricher tail of the legacy file is intentionally NOT ported
 *     (out of scope — see the wave plan §4 "Out").
 */
import type { Symbol, Relationship, Process, ProcessStep, DataFlowEdge } from "../../../core/domain.js";

// ─── Configuration (ported verbatim) ───────────────────────────────────────────

export interface DataFlowConfig {
  /** Maximum steps to trace per path. */
  maxTraceDepth: number;
  /** Max branches expanded per node. */
  maxBranching: number;
  /** Maximum flows (Process records) to assemble. */
  maxFlows: number;
  /** Minimum steps for a valid flow. */
  minSteps: number;
}

/**
 * Default bounds, ported VERBATIM from the legacy parser. NOTE: the legacy doc
 * comment claims `minSteps` 3, but the literal is `2` — we port the literal.
 */
export const DEFAULT_CONFIG: DataFlowConfig = {
  maxTraceDepth: 12,
  maxBranching: 4,
  maxFlows: 200,
  minSteps: 2,
};

/** Adjacency edges below this confidence are dropped from both adjacency lists. */
export const MIN_CONFIDENCE = 0.5;

/**
 * RelTypes traversed during data-flow tracing. `handlesRoute` is intentionally
 * EXCLUDED (see module docstring); the endpoint is resolved from the entry's own
 * `handlesRoute` edge instead.
 */
const DATA_FLOW_EDGE_TYPES: ReadonlySet<string> = new Set([
  "calls",
  "writesToDb",
  "readsFromDb",
  "publishesEvent",
  "subscribesTo",
]);

const PRIMITIVE_TYPES = new Set([
  "string", "number", "boolean", "void", "int", "float", "double",
  "undefined", "null", "any", "object", "promise", "observable",
]);

// ─── Internal types ─────────────────────────────────────────────────────────────

type EdgeType = string;

interface AdjEntry {
  targetId: string;
  edgeType: EdgeType;
}

type DataAdjacency = Map<string, AdjEntry[]>;

interface DataFlowStep {
  nodeId: string;
  edgeType: EdgeType | "ENTRY";
  step: number;
}

interface TracedFlow {
  steps: DataFlowStep[];
  dbTables: string[];
  hasDBTouch: boolean;
}

interface ApiInfo {
  httpMethod: string;
  httpPath: string;
  endpointId: string;
}

/** Lightweight view of the inputs the assembler reads (id-keyed). */
interface FlowGraph {
  symbolsById: ReadonlyMap<string, Symbol>;
  relationships: readonly Relationship[];
}

export interface FlowAssemblyResult {
  /** Assembled flows as `Process` records (REUSES the Process persistence). */
  flows: Process[];
  stats: {
    totalFlows: number;
    avgStepCount: number;
    endpointsTraced: number;
    dbModelsReached: number;
  };
}

// ─── Confidence / table helpers ─────────────────────────────────────────────────

/** Read the stringified `metadata.confidence` (default 1.0 for un-scored edges like `calls`). */
function edgeConfidence(rel: Relationship): number {
  const raw = rel.metadata?.confidence;
  if (raw === undefined || raw === "") return 1.0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 1.0;
}

/**
 * The DB-table name a model Symbol stands for. A step is only passed here when it
 * was reached via a `readsFromDb`/`writesToDb` edge, so the Symbol IS the model
 * endpoint — its `name` is the table. Covers BOTH the synthetic `dbmodel:<table>`
 * anchors (Prisma / heuristic-only tables) and REAL model class Symbols
 * (`@Entity`, `*Entity` suffix, `entities/` path) reused as the edge target.
 */
function dbTableOf(sym: Symbol | undefined): string | undefined {
  if (!sym) return undefined;
  if (sym.id.startsWith("dbmodel:")) return sym.name;
  // A real model class reused as the DB endpoint — use its (lower-cased) name.
  return sym.name.toLowerCase();
}

// ─── Adjacency ──────────────────────────────────────────────────────────────────

function buildForwardAdjacency(graph: FlowGraph): DataAdjacency {
  const adj: DataAdjacency = new Map();
  for (const rel of graph.relationships) {
    if (!DATA_FLOW_EDGE_TYPES.has(rel.relType)) continue;
    if (edgeConfidence(rel) < MIN_CONFIDENCE) continue;
    const list = adj.get(rel.source) ?? [];
    list.push({ targetId: rel.target, edgeType: rel.relType });
    adj.set(rel.source, list);
  }
  return adj;
}

// ─── Entry points ─────────────────────────────────────────────────────────────

function findDataEntryPoints(graph: FlowGraph, forwardAdj: DataAdjacency): string[] {
  const candidates: { id: string; priority: number }[] = [];

  // Route handlers (sources of handlesRoute edges) are ALWAYS candidates, even
  // with no outgoing data edges — handlesRoute is excluded from forwardAdj, so a
  // Prisma-only handler has no forward edge but still must be traced.
  const routeHandlerIds = new Set<string>();
  // EventChannels: synthetic `eventchannel:` Symbols (targets/sources of event edges).
  const eventChannelIds = new Set<string>();
  for (const rel of graph.relationships) {
    if (rel.relType === "handlesRoute") routeHandlerIds.add(rel.source);
    if (rel.relType === "subscribesTo") eventChannelIds.add(rel.source);
    if (rel.relType === "publishesEvent") eventChannelIds.add(rel.target);
  }

  for (const [, sym] of graph.symbolsById) {
    const hasOutgoing = forwardAdj.has(sym.id);

    // Priority 1b: EventChannels start a flow at the channel/queue itself.
    if (eventChannelIds.has(sym.id) && sym.id.startsWith("eventchannel:")) {
      candidates.push({ id: sym.id, priority: 95 });
      continue;
    }

    // Priority 2: route handler methods — always candidates.
    if (routeHandlerIds.has(sym.id)) {
      candidates.push({ id: sym.id, priority: 90 });
      continue;
    }

    // Priority 3: high-entry-point-score functions/methods WITH outgoing edges.
    if (!hasOutgoing) continue;
    if (sym.kind === "function" || sym.kind === "method") {
      const score = entryPointScore(sym);
      if (score > 1.0) candidates.push({ id: sym.id, priority: score });
    }
  }

  const seen = new Set<string>();
  return candidates
    .sort((a, b) => b.priority - a.priority)
    .filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    })
    .slice(0, 300)
    .map((c) => c.id);
}

/**
 * Approximate the legacy `entryPointScore` from typocop's Wave 2 entry-point
 * carriers. A classified entry-point symbol (`entryPointKind` set) scores >1.0
 * (so it enters the candidate set); everything else scores 0 (skipped unless it
 * is a route handler / event channel, handled above).
 */
function entryPointScore(sym: Symbol): number {
  return sym.entryPointKind ? 2.0 : 0;
}

// ─── BFS tracing ────────────────────────────────────────────────────────────────

function traceDataFlow(
  entryId: string,
  adj: DataAdjacency,
  graph: FlowGraph,
  config: DataFlowConfig,
): TracedFlow[] {
  const results: TracedFlow[] = [];
  const queue: { nodeId: string; path: DataFlowStep[] }[] = [
    { nodeId: entryId, path: [{ nodeId: entryId, edgeType: "ENTRY", step: 1 }] },
  ];

  while (queue.length > 0 && results.length < config.maxBranching * 4) {
    const { nodeId, path } = queue.shift()!;
    const neighbors = adj.get(nodeId) ?? [];

    if (neighbors.length === 0 || path.length >= config.maxTraceDepth) {
      if (path.length >= config.minSteps) results.push(buildTracedFlow(path, graph));
      continue;
    }

    const limited = neighbors.slice(0, config.maxBranching);
    let extended = false;

    for (const { targetId, edgeType } of limited) {
      if (path.some((s) => s.nodeId === targetId)) continue; // cycle guard
      queue.push({
        nodeId: targetId,
        path: [...path, { nodeId: targetId, edgeType, step: path.length + 1 }],
      });
      extended = true;
    }

    // Dead-end flush: all neighbors were cycles → capture the path as-is.
    if (!extended && path.length >= config.minSteps) {
      results.push(buildTracedFlow(path, graph));
    }
  }

  return results;
}

function buildTracedFlow(steps: DataFlowStep[], graph: FlowGraph): TracedFlow {
  const dbTables: string[] = [];
  let hasDBTouch = false;
  for (const step of steps) {
    if (step.edgeType === "writesToDb" || step.edgeType === "readsFromDb") {
      hasDBTouch = true;
      const table = dbTableOf(graph.symbolsById.get(step.nodeId));
      if (table && !dbTables.includes(table)) dbTables.push(table);
    }
  }
  return { steps, dbTables, hasDBTouch };
}

// ─── Deduplication ──────────────────────────────────────────────────────────────

function deduplicateFlows(flows: TracedFlow[]): TracedFlow[] {
  if (flows.length === 0) return [];

  // Dedup by (firstNode, lastNode): prefer DB-touching, then longer.
  const byEndpoints = new Map<string, TracedFlow>();
  for (const flow of flows) {
    const key = `${flow.steps[0].nodeId}::${flow.steps[flow.steps.length - 1].nodeId}`;
    const existing = byEndpoints.get(key);
    if (
      !existing ||
      (flow.hasDBTouch && !existing.hasDBTouch) ||
      (flow.hasDBTouch === existing.hasDBTouch && flow.steps.length > existing.steps.length)
    ) {
      byEndpoints.set(key, flow);
    }
  }

  // Subset removal: drop a flow whose joined trace is contained in a longer kept one.
  const sorted = [...byEndpoints.values()].sort((a, b) => b.steps.length - a.steps.length);
  const unique: TracedFlow[] = [];
  for (const flow of sorted) {
    const traceKey = flow.steps.map((s) => s.nodeId).join("->");
    const isSubset = unique.some((existing) =>
      existing.steps.map((s) => s.nodeId).join("->").includes(traceKey),
    );
    if (!isSubset) unique.push(flow);
  }
  return unique;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractSimpleType(returnType: string): string | null {
  let text = returnType.trim();
  const generic = text.match(/^(?:Promise|Observable|Task)\s*<(.+)>$/);
  if (generic) text = generic[1].trim();
  text = text.replace(/\s*\|\s*(?:null|undefined|void)\s*/g, "").trim();
  if (PRIMITIVE_TYPES.has(text.toLowerCase())) return null;
  if (!/^[A-Z]/.test(text)) return null;
  return text;
}

function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 24).toLowerCase();
}

// ─── Main assembler ─────────────────────────────────────────────────────────────

/**
 * Assemble DataFlow `Process` records from the resolved + data-touch-augmented
 * graph. Pure with respect to its inputs.
 *
 * @param symbols      ALL symbols (real + synthetic anchors from detection).
 * @param relationships ALL relationships (calls + data-touch edges).
 * @param config       optional bound overrides (defaults to {@link DEFAULT_CONFIG}).
 */
export function assembleDataFlows(
  symbols: readonly Symbol[],
  relationships: readonly Relationship[],
  config: Partial<DataFlowConfig> = {},
): FlowAssemblyResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const symbolsById = new Map<string, Symbol>();
  for (const sym of symbols) symbolsById.set(sym.id, sym);
  const graph: FlowGraph = { symbolsById, relationships };

  const forwardAdj = buildForwardAdjacency(graph);
  const entryPoints = findDataEntryPoints(graph, forwardAdj);

  // Trace from each entry point (bounded by maxFlows*2 traces).
  const allTraces: TracedFlow[] = [];
  for (let i = 0; i < entryPoints.length && allTraces.length < cfg.maxFlows * 2; i++) {
    allTraces.push(...traceDataFlow(entryPoints[i], forwardAdj, graph, cfg));
  }

  const uniqueTraces = deduplicateFlows(allTraces);
  const limited = uniqueTraces
    .sort((a, b) => b.steps.length - a.steps.length)
    .slice(0, cfg.maxFlows);

  // handler method id → its OWN APIEndpoint info (resolved from handlesRoute,
  // which is excluded from BFS). The synthetic endpoint Symbol's name is
  // "<METHOD> <path>", so we recover method/path from it.
  const handlerToAPI = new Map<string, ApiInfo>();
  for (const rel of relationships) {
    if (rel.relType !== "handlesRoute") continue;
    const endpoint = symbolsById.get(rel.target);
    if (!endpoint) continue;
    const { httpMethod, httpPath } = parseEndpointName(endpoint);
    handlerToAPI.set(rel.source, { httpMethod, httpPath, endpointId: rel.target });
  }

  // reverse CALLS: targetId → sourceIds (who calls this method?).
  const reverseCallers = new Map<string, string[]>();
  for (const rel of relationships) {
    if (rel.relType !== "calls") continue;
    const list = reverseCallers.get(rel.target) ?? [];
    list.push(rel.source);
    reverseCallers.set(rel.target, list);
  }

  // Walk up to 2 reverse-CALLS hops to find a calling controller with a route.
  const findCallerWithRoute = (nodeId: string): { callerId: string; api: ApiInfo } | null => {
    const callers = reverseCallers.get(nodeId) ?? [];
    for (const callerId of callers) {
      const api = handlerToAPI.get(callerId);
      if (api) return { callerId, api };
    }
    for (const callerId of callers) {
      for (const callerId2 of reverseCallers.get(callerId) ?? []) {
        const api = handlerToAPI.get(callerId2);
        if (api) return { callerId: callerId2, api };
      }
    }
    return null;
  };

  const flows: Process[] = [];
  let dbModelsReached = 0;

  for (let idx = 0; idx < limited.length; idx++) {
    const trace = limited[idx];
    let entryPointId = trace.steps[0].nodeId;
    const terminalId = trace.steps[trace.steps.length - 1].nodeId;

    let entryAPI = handlerToAPI.get(entryPointId);
    // Trivial-flow skip: a 2-step handler → its own endpoint self-reference.
    if (trace.steps.length <= 2 && entryAPI && terminalId === entryAPI.endpointId) {
      continue;
    }

    // Prepend the calling controller when the entry is NOT itself a route handler.
    if (!entryAPI) {
      const callerInfo = findCallerWithRoute(entryPointId);
      if (callerInfo) {
        entryAPI = callerInfo.api;
        for (const step of trace.steps) step.step += 1;
        trace.steps.unshift({ nodeId: callerInfo.callerId, edgeType: "ENTRY", step: 0 });
        entryPointId = callerInfo.callerId;
      }
    }

    // Inject the APIEndpoint anchor as a visible step 1 so the flow starts at it.
    if (entryAPI && trace.steps[0].nodeId !== entryAPI.endpointId) {
      trace.steps.unshift({ nodeId: entryAPI.endpointId, edgeType: "ENTRY", step: 0 });
      trace.steps.forEach((st, i) => (st.step = i + 1));
    }

    // Collect data-entity + DB-table metadata across the steps. A DB table is
    // collected ONLY for a step reached via a DB edge (that step's node IS the
    // model endpoint) — typocop has no DBModel node label to filter on, so the
    // edge type is the discriminator (mirrors `buildTracedFlow`).
    const dataEntities: string[] = [];
    const dbTables: string[] = [];
    for (const step of trace.steps) {
      const node = symbolsById.get(step.nodeId);
      if (!node) continue;
      if (node.returnType) {
        const typeName = extractSimpleType(node.returnType);
        if (typeName && !dataEntities.includes(typeName)) dataEntities.push(typeName);
      }
      if (step.edgeType === "readsFromDb" || step.edgeType === "writesToDb") {
        const table = dbTableOf(node);
        if (table && !dbTables.includes(table)) {
          dbTables.push(table);
          dbModelsReached++;
        }
      }
    }

    const httpMethod = entryAPI?.httpMethod;
    const httpPath = entryAPI?.httpPath;
    const entryName = symbolsById.get(entryPointId)?.name ?? "Unknown";
    const terminalName = symbolsById.get(terminalId)?.name ?? "Unknown";

    let flowName: string;
    if (httpMethod && httpPath) {
      flowName = dbTables.length > 0
        ? `${httpMethod} ${httpPath} -> ${dbTables.join(", ")}`
        : `${httpMethod} ${httpPath} -> ${terminalName}`;
    } else {
      flowName = `${entryName} -> ${terminalName}`;
    }

    // Map onto the existing Process shape. `steps` become 0-indexed, gapless
    // ProcessSteps; `dataFlow` is the consecutive-pair DataFlowEdge list.
    const flowId = `dataflow_${idx}_${sanitizeId(entryName)}`;
    const steps: ProcessStep[] = trace.steps.map((st, i) => ({
      order: i,
      symbolId: st.nodeId,
      description: symbolsById.get(st.nodeId)?.name ?? st.nodeId,
    }));
    const dataFlow: DataFlowEdge[] = [];
    for (let i = 0; i < trace.steps.length - 1; i++) {
      const from = trace.steps[i].nodeId;
      const to = trace.steps[i + 1].nodeId;
      const dt = dataEntities.length > 0 ? dataEntities[0] : undefined;
      dataFlow.push({ from, to, ...(dt ? { dataType: dt } : {}) });
    }

    flows.push({
      id: flowId,
      name: flowName,
      entryPoint: entryPointId,
      steps,
      dataFlow,
    });
  }

  const avgStepCount = flows.length > 0
    ? flows.reduce((sum, f) => sum + f.steps.length, 0) / flows.length
    : 0;

  return {
    flows,
    stats: {
      totalFlows: flows.length,
      avgStepCount: Math.round(avgStepCount * 10) / 10,
      endpointsTraced: entryPoints.length,
      dbModelsReached,
    },
  };
}

/** Recover `{httpMethod, httpPath}` from a synthetic endpoint Symbol's name (`"GET /users"`). */
function parseEndpointName(endpoint: Symbol): { httpMethod: string; httpPath: string } {
  // Synthetic anchors are named "<METHOD> <path>"; framework route Symbols (Wave 6)
  // may differ, so fall back to the id-suffix (`apiendpoint:<METHOD>:<path>`).
  const m = endpoint.name.match(/^([A-Z]+)\s+(\/\S*)$/);
  if (m) return { httpMethod: m[1], httpPath: m[2] };
  const idMatch = endpoint.id.match(/^apiendpoint:([A-Z]+):(.+)$/);
  if (idMatch) return { httpMethod: idMatch[1], httpPath: idMatch[2] };
  return { httpMethod: "", httpPath: "" };
}
