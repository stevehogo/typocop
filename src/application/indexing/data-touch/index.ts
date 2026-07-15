/**
 * Wave 5 — data-touch detection orchestrator (FOUNDATION + DETECTION).
 *
 * Runs the heuristic detectors over the resolved `Symbol[]` + `Relationship[]`
 * graph and returns an ADDITIVE augmentation: the new synthetic anchor Symbols
 * and the new data-touch edges. The caller (a later pipeline stage) merges them
 * into the global `symbols`/`relationships` arrays before clustering/persist.
 *
 * This module does NOT mutate its inputs and does NOT wire itself into the
 * pipeline — it is the detection core, gated by `PipelineConfig.dataTouch`. When
 * the flag is off the pass never runs and the graph is byte-identical to
 * pre-Wave-5.
 *
 * Wave-6 coupling seam (NOW ACTIVE): `runDataTouchDetection` accepts optional
 * `extractedRoutes`/`extractedEvents` (the framework extractors' structured
 * records). When present, a new Step 0 emits HIGH-confidence (1.0)
 * `handlesRoute`/`subscribesTo` edges FIRST and seeds the `alreadyLinked` /
 * `alreadySubscribed` defer sets, so the heuristic passes here skip any
 * handler/subscriber already linked. Empty/absent inputs ⇒ Step 0 is a no-op and
 * detection is byte-identical pre-Wave-6 (records only flow when BOTH framework
 * extraction AND data-touch are on — both default OFF).
 */
import type { Symbol, Relationship, Process } from "../../../core/domain.js";
import {
  emptyCounters,
  indexById,
  type DataTouchSink,
  type DataTouchCounters,
  type ExtractedRouteInput,
  type ExtractedEventSubscriberInput,
} from "./types.js";
import { detectDBModels, detectPrismaModels, type DbModelMap } from "./db-models.js";
import { linkDBOperations } from "./db-operations.js";
import {
  detectAPIEndpointsFromNodes,
  detectExpressStyleRoutes,
  collectAlreadyLinked,
} from "./routes.js";
import { detectEventChannels } from "./events.js";
import { processExtractedRoutes, processExtractedEvents } from "./extracted-records.js";
import { assembleDataFlows, type DataFlowConfig } from "./data-flow-assembly.js";
import { annotateEntryPoints } from "../processes/index.js";

export interface DataTouchOptions {
  /** Enable the heuristic event detector (`dataTouch.events`). Default OFF. */
  readonly events?: boolean;
  /** Enable the single-model DB fallback (strategy 5). Default OFF. */
  readonly singleModelFallback?: boolean;
  /**
   * Wave 6 structured routes (from the framework extractors). When present, a NEW
   * Step 0 emits HIGH-confidence `handlesRoute` edges from them FIRST and seeds the
   * `alreadyLinked` defer set, so the heuristic route passes defer to them. Empty/
   * absent ⇒ Step 0 is a no-op and detection is byte-identical pre-Wave-6.
   */
  readonly extractedRoutes?: readonly ExtractedRouteInput[];
  /**
   * Wave 6 structured event subscribers. When present, Step 0 emits HIGH-confidence
   * `subscribesTo` edges and seeds the `alreadySubscribed` defer set the heuristic
   * event pass now consults. Empty/absent ⇒ no-op.
   */
  readonly extractedEvents?: readonly ExtractedEventSubscriberInput[];
}

export interface DataTouchResult {
  /** Synthetic anchor Symbols minted by the pass (additive). */
  readonly newSymbols: Symbol[];
  /** Data-touch edges emitted by the pass (additive). */
  readonly newRelationships: Relationship[];
  /** Per-category counters (endpoints/models/channels + edges). */
  readonly counters: DataTouchCounters;
}

/**
 * Detect DB models / routes / (optionally) events and return the additive
 * synthetic Symbols + data-touch edges. Pure with respect to the inputs.
 *
 * Order mirrors the legacy pass (routes → models → events → DB-op linking) so the
 * `alreadyLinked` defer set and the model map are populated before they are read.
 */
export function runDataTouchDetection(
  symbols: readonly Symbol[],
  relationships: readonly Relationship[],
  options: DataTouchOptions = {},
): DataTouchResult {
  const sink: DataTouchSink = {
    newSymbols: [],
    newRelationships: [],
    counters: emptyCounters(),
  };

  // Index existing symbols by id (callees/owners are resolved by id). Synthetic
  // anchors minted mid-pass are added so later strategies can see them.
  const symbolsById = indexById(symbols);
  const registerNew = (sym: Symbol): void => {
    symbolsById.set(sym.id, sym);
  };

  // ── Step 0: Structured records (Wave 6) ───────────────────────────────────
  // Consume the framework extractors' ground-truth records FIRST: emit HIGH-
  // confidence `handlesRoute`/`subscribesTo` edges and seed the defer sets so the
  // heuristic passes below skip any handler/subscriber already linked. Empty when
  // framework extraction is off (records only flow when BOTH flags are on), so the
  // default graph is byte-identical pre-Wave-6.
  const alreadyLinked = collectAlreadyLinked(relationships);
  const alreadySubscribed = new Set<string>();
  if (options.extractedRoutes && options.extractedRoutes.length > 0) {
    const beforeStructuredRouteSymbols = sink.newSymbols.length;
    processExtractedRoutes(options.extractedRoutes, symbols, symbolsById, alreadyLinked, sink);
    for (let i = beforeStructuredRouteSymbols; i < sink.newSymbols.length; i++) registerNew(sink.newSymbols[i]);
  }
  if (options.extractedEvents && options.extractedEvents.length > 0) {
    const beforeStructuredEventSymbols = sink.newSymbols.length;
    processExtractedEvents(options.extractedEvents, symbols, symbolsById, alreadySubscribed, sink);
    for (let i = beforeStructuredEventSymbols; i < sink.newSymbols.length; i++) registerNew(sink.newSymbols[i]);
  }

  // ── Step 1: Routes ────────────────────────────────────────────────────────
  // `alreadyLinked` is seeded by Step 0's structured routes + any pre-existing
  // handlesRoute edges, so these heuristic passes defer to the structured links.
  const beforeRouteSymbols = sink.newSymbols.length;
  detectAPIEndpointsFromNodes(symbols, symbolsById, alreadyLinked, sink);
  detectExpressStyleRoutes(symbolsById, relationships, alreadyLinked, sink);
  for (let i = beforeRouteSymbols; i < sink.newSymbols.length; i++) registerNew(sink.newSymbols[i]);

  // ── Step 2: DB models ───────────────────────────────────────────────────────
  const models: DbModelMap = new Map();
  detectDBModels(symbols, models);
  const beforeModelSymbols = sink.newSymbols.length;
  detectPrismaModels(symbols, models, sink);
  for (let i = beforeModelSymbols; i < sink.newSymbols.length; i++) registerNew(sink.newSymbols[i]);

  // ── Step 3: Events (DARK by default) ─────────────────────────────────────────
  if (options.events) {
    const beforeEventSymbols = sink.newSymbols.length;
    detectEventChannels(symbols, symbolsById, relationships, sink, alreadySubscribed);
    for (let i = beforeEventSymbols; i < sink.newSymbols.length; i++) registerNew(sink.newSymbols[i]);
  }

  // ── Step 4: Link DB operations ───────────────────────────────────────────────
  linkDBOperations(symbolsById, relationships, models, sink, {
    singleModelFallback: options.singleModelFallback,
  });

  return {
    newSymbols: sink.newSymbols,
    newRelationships: sink.newRelationships,
    counters: sink.counters,
  };
}

/** Result of the full Wave 5 pass: detection augmentation + assembled flows. */
export interface DataTouchPassResult {
  /** Synthetic anchor Symbols minted by detection (additive). */
  readonly newSymbols: Symbol[];
  /** Data-touch edges emitted by detection (additive). */
  readonly newRelationships: Relationship[];
  /** Assembled DataFlow `Process` records (additive, append to Phase 5 output). */
  readonly flows: Process[];
  /** Per-category detection counters. */
  readonly counters: DataTouchCounters;
}

export interface DataTouchPassOptions extends DataTouchOptions {
  /** Optional flow-assembly bound overrides (defaults to `DEFAULT_CONFIG`). */
  readonly flowConfig?: Partial<DataFlowConfig>;
}

/**
 * The full Wave 5 data-touch pass: run heuristic DETECTION over the resolved
 * `calls` graph, then ASSEMBLE end-to-end flows over the augmented graph
 * (real symbols + synthetic anchors, real edges + data-touch edges).
 *
 * Purely additive and side-effect-free with respect to its inputs: returns the
 * new synthetic Symbols, the new data-touch edges, and the assembled flow
 * `Process` records. The caller merges them into the global `symbols`/
 * `relationships`/`processes` arrays BEFORE clustering/persist (so the persist
 * row-accounting in `countPersistRows` balances).
 *
 * This is a GLOBAL aggregate: it re-runs whole-graph each index (like
 * clustering/processes), never per-file — no new delta bookkeeping.
 */
export function runDataTouchPass(
  symbols: readonly Symbol[],
  relationships: readonly Relationship[],
  options: DataTouchPassOptions = {},
): DataTouchPassResult {
  const detection = runDataTouchDetection(symbols, relationships, options);

  // Assemble flows over the AUGMENTED graph: real symbols + new synthetic
  // anchors, real relationships + new data-touch edges.
  //
  // The flow BFS's secondary entry-point signal is `Symbol.entryPointKind`
  // (`findDataEntryPoints` scores classified entry points). In the pipeline this
  // pass runs at Phase 3.5, BEFORE the Phase-5 `annotateEntryPoints` step, so the
  // input symbols carry no `entryPointKind` yet. Annotate a LOCAL copy here (pure,
  // additive — the returned synthetics/edges/flows are unaffected by this view) so
  // non-route entry points (high-score functions) can seed flows. The route-handler
  // entry points (the primary signal) come from the `handlesRoute` edges regardless.
  const annotated = annotateEntryPoints([...symbols], [...relationships]);
  const augmentedSymbols = [...annotated, ...detection.newSymbols];
  const augmentedRelationships = [...relationships, ...detection.newRelationships];
  const assembly = assembleDataFlows(augmentedSymbols, augmentedRelationships, options.flowConfig);

  return {
    newSymbols: detection.newSymbols,
    newRelationships: detection.newRelationships,
    flows: assembly.flows,
    counters: detection.counters,
  };
}

export { assembleDataFlows, DEFAULT_CONFIG, MIN_CONFIDENCE } from "./data-flow-assembly.js";
export type { DataFlowConfig, FlowAssemblyResult } from "./data-flow-assembly.js";
export type {
  DataTouchCounters,
  ExtractedRouteInput,
  ExtractedEventSubscriberInput,
} from "./types.js";
