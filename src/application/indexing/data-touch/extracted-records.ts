/**
 * Wave 6 → Wave 5 bridge — structured-record consumption (Step 0).
 *
 * The framework extractors (Wave 6) emit ground-truth `ExtractedRoute[]` /
 * `ExtractedEventSubscriber[]` out of Phase 2. This module turns those structured
 * records into `handlesRoute` / `subscribesTo` data-touch edges at HIGH confidence
 * (1.0 — structured beats the 0.85/0.7 heuristic) and seeds the `alreadyLinked` /
 * `alreadySubscribed` defer sets so the heuristic passes (`detectAPIEndpointsFromNodes`
 * / `detectExpressStyleRoutes` / `detectEventChannels`) NEVER double-link a handler
 * a structured extractor already linked.
 *
 * It runs as a NEW "Step 0" BEFORE the heuristic Step 1/Step 3 in
 * `runDataTouchDetection`, gated on records being present (records are present only
 * when BOTH framework extraction AND data-touch are on — both default OFF — so the
 * default graph is byte-identical).
 *
 * No new `RelationType` is introduced here: `handlesRoute` / `subscribesTo` are the
 * ones Wave 5 already defined.
 */
import type { Symbol } from "../../../core/domain.js";
import {
  EVENT_CHANNEL_ID_PREFIX,
  makeSyntheticSymbol,
  makeDataTouchEdge,
  normalizePath,
  type DataTouchSink,
  type ExtractedRouteInput,
  type ExtractedEventSubscriberInput,
} from "./types.js";
import { ensureEndpoint, endpointMapCarrier } from "./routes.js";

/**
 * Resolve a structured route to the intra-run `id` of its handler Symbol.
 *
 * Strategy (most → least specific):
 *  1. If the route carries a `handlerNodeId` (NestJS), match a Symbol whose
 *     `logicalKey` equals it (the extractor minted it via `generateLogicalKey`).
 *  2. Else match a method/function Symbol by `name === methodName`, preferring one
 *     whose owning class name equals `controllerName` (via `ownerId`), then one in
 *     the same `filePath`.
 *
 * Returns the resolved Symbol's intra-run `id` (edges use `id`; the persist layer
 * translates `id → logicalKey`), or `null` when no handler resolves.
 */
function resolveHandlerId(
  route: ExtractedRouteInput,
  symbols: readonly Symbol[],
  byLogicalKey: ReadonlyMap<string, Symbol>,
  symbolsById: ReadonlyMap<string, Symbol>,
): string | null {
  if (route.handlerNodeId) {
    const direct = byLogicalKey.get(route.handlerNodeId);
    if (direct) return direct.id;
    // The id scheme may also be the intra-run id in some fixtures.
    if (symbolsById.has(route.handlerNodeId)) return route.handlerNodeId;
  }
  if (!route.methodName) return null;

  let byOwner: Symbol | null = null;
  let byFile: Symbol | null = null;
  let anyMatch: Symbol | null = null;
  for (const sym of symbols) {
    if (sym.kind !== "method" && sym.kind !== "function") continue;
    if (sym.synthetic) continue;
    if (sym.name !== route.methodName) continue;
    anyMatch ??= sym;
    if (route.controllerName && sym.ownerId) {
      const owner = symbolsById.get(sym.ownerId);
      if (owner && owner.name === route.controllerName) {
        byOwner = sym;
        break;
      }
    }
    if (byFile === null && sym.location.filePath === route.filePath) byFile = sym;
  }
  return (byOwner ?? byFile ?? anyMatch)?.id ?? null;
}

/**
 * Emit `handlesRoute` edges from the structured routes and seed `alreadyLinked`.
 *
 * Endpoints are minted through the SHARED `ensureEndpoint`/`endpointMapCarrier`
 * dedup table so the heuristic passes reuse the same `<METHOD>:<path>` anchor.
 * `ANY`-method resource routes (Laravel `apiResource`/`resource` expansion) build
 * one endpoint per expanded action path.
 */
export function processExtractedRoutes(
  routes: readonly ExtractedRouteInput[],
  symbols: readonly Symbol[],
  symbolsById: ReadonlyMap<string, Symbol>,
  alreadyLinked: Set<string>,
  sink: DataTouchSink,
): void {
  if (routes.length === 0) return;

  const byLogicalKey = new Map<string, Symbol>();
  for (const sym of symbols) byLogicalKey.set(sym.logicalKey, sym);

  // Use the same per-sink endpoint dedup table the heuristic passes share.
  let endpointsByKey = endpointMapCarrier.get(sink);
  if (endpointsByKey === undefined) {
    endpointsByKey = new Map<string, string>();
    endpointMapCarrier.set(sink, endpointsByKey);
  }

  for (const route of routes) {
    const handlerId = resolveHandlerId(route, symbols, byLogicalKey, symbolsById);
    if (handlerId === null) continue;

    const fullPath = normalizePath(route.prefix, route.routePath);
    const endpointId = ensureEndpoint(
      route.httpMethod,
      fullPath,
      route.filePath,
      route.lineNumber,
      endpointsByKey,
      sink,
    );

    sink.newRelationships.push(
      makeDataTouchEdge({
        relType: "handlesRoute",
        source: handlerId,
        target: endpointId,
        confidence: 1.0,
        reason: "ast-extracted-route",
      }),
    );
    sink.counters.routeEdges++;
    // Make the heuristic passes defer to this structured link.
    alreadyLinked.add(handlerId);
  }
}

/**
 * Emit `subscribesTo` edges from the structured subscribers and seed
 * `alreadySubscribed`. Mints/reuses an `eventchannel:<topic>` anchor (same id
 * convention as the heuristic `ensureChannel`). The subscriber Symbol is resolved
 * by `className`+`methodName` (or `methodName` alone).
 *
 * The defer set keys on the subscriber Symbol's intra-run `id`; the heuristic
 * event pass (`detectEventChannels`) consults it (added in this wave) so it never
 * re-subscribes a method a structured extractor already linked.
 */
export function processExtractedEvents(
  events: readonly ExtractedEventSubscriberInput[],
  symbols: readonly Symbol[],
  symbolsById: ReadonlyMap<string, Symbol>,
  alreadySubscribed: Set<string>,
  sink: DataTouchSink,
): void {
  if (events.length === 0) return;

  const channelsByKey = new Map<string, string>();

  for (const ev of events) {
    if (!ev.topicName) continue;
    const subscriberId = resolveSubscriberId(ev, symbols, symbolsById);
    if (subscriberId === null) continue;

    const channelId = ensureChannel(ev.topicName, ev.filePath, channelsByKey, sink);
    sink.newRelationships.push(
      makeDataTouchEdge({
        relType: "subscribesTo",
        source: channelId,
        target: subscriberId,
        confidence: 1.0,
        reason: `ast-extracted-subscriber-${ev.framework}`,
      }),
    );
    sink.counters.eventEdges++;
    alreadySubscribed.add(subscriberId);
  }
}

/** Resolve a structured subscriber to its handler-method/class Symbol id. */
function resolveSubscriberId(
  ev: ExtractedEventSubscriberInput,
  symbols: readonly Symbol[],
  symbolsById: ReadonlyMap<string, Symbol>,
): string | null {
  // Prefer the handler method; for a class-level subscriber whose method is the
  // class name (no conventional handler found) fall back to the class Symbol.
  let byOwner: Symbol | null = null;
  let byFile: Symbol | null = null;
  let anyMatch: Symbol | null = null;
  if (ev.methodName) {
    for (const sym of symbols) {
      if (sym.kind !== "method" && sym.kind !== "function") continue;
      if (sym.synthetic) continue;
      if (sym.name !== ev.methodName) continue;
      anyMatch ??= sym;
      if (ev.className && sym.ownerId) {
        const owner = symbolsById.get(sym.ownerId);
        if (owner && owner.name === ev.className) {
          byOwner = sym;
          break;
        }
      }
      if (byFile === null && sym.location.filePath === ev.filePath) byFile = sym;
    }
    const method = (byOwner ?? byFile ?? anyMatch)?.id ?? null;
    if (method !== null) return method;
  }
  // Fall back to the class Symbol (class-level subscriber with no handler method).
  if (ev.className) {
    for (const sym of symbols) {
      if (sym.kind === "class" && !sym.synthetic && sym.name === ev.className) return sym.id;
    }
  }
  return null;
}

/** Mint/reuse an `eventchannel:<topic>` anchor Symbol (mirrors `ensureChannel`). */
function ensureChannel(
  topic: string,
  filePath: string,
  channelsByKey: Map<string, string>,
  sink: DataTouchSink,
): string {
  const existing = channelsByKey.get(topic);
  if (existing) return existing;
  const channelId = `${EVENT_CHANNEL_ID_PREFIX}${topic}`;
  sink.newSymbols.push(
    makeSyntheticSymbol({ id: channelId, name: topic, kind: "class", filePath }),
  );
  channelsByKey.set(topic, channelId);
  sink.counters.eventChannels++;
  return channelId;
}
