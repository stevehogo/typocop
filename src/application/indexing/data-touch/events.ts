/**
 * Wave 5 — heuristic event-channel detection (ported, DEFAULT-OFF).
 *
 * `detectEventChannels` is the pure-heuristic event detector. It is intentionally
 * NOT run unless the `events` sub-flag is enabled (`dataTouch.events`, default
 * OFF): the publish verbs (`emit`/`send`/`add`/…) are wildly overloaded, so this
 * is noisy until Wave 6 supplies extracted channel args. Shipped now so the flow
 * BFS *can* traverse `publishesEvent`/`subscribesTo` edges once enabled.
 *
 * Ported from the legacy parser. Subscribe-decorator text and the `channelArgument`
 * are read from `Symbol.signature` / `Relationship.metadata` (typocop has no
 * `node.properties.description` nor `rel.properties.channelArgument`).
 */
import type { Symbol, Relationship } from "../../../core/domain.js";
import {
  EVENT_SUBSCRIBE_PATTERNS,
  EVENT_PUBLISH_PATTERNS,
  EVENT_CHANNEL_ID_PREFIX,
  makeSyntheticSymbol,
  makeDataTouchEdge,
  type DataTouchSink,
} from "./types.js";

function ensureChannel(
  channelKey: string,
  name: string,
  filePath: string,
  channelsByKey: Map<string, string>,
  sink: DataTouchSink,
): string {
  const existing = channelsByKey.get(channelKey);
  if (existing) return existing;
  const channelId = `${EVENT_CHANNEL_ID_PREFIX}${channelKey}`;
  sink.newSymbols.push(
    makeSyntheticSymbol({ id: channelId, name, kind: "class", filePath }),
  );
  channelsByKey.set(channelKey, channelId);
  sink.counters.eventChannels++;
  return channelId;
}

/**
 * Heuristic event-channel detection. Two passes: subscribe decorators on
 * method/function signatures, then emit/publish `calls` edges. Mutates `sink`.
 * Caller MUST gate this behind the `events` sub-flag (default OFF).
 */
export function detectEventChannels(
  symbols: readonly Symbol[],
  symbolsById: ReadonlyMap<string, Symbol>,
  relationships: readonly Relationship[],
  sink: DataTouchSink,
): void {
  const channelsByKey = new Map<string, string>();

  // Pass 1 — subscribe decorators.
  for (const sym of symbols) {
    if (sym.kind !== "method" && sym.kind !== "function") continue;
    if (sym.synthetic) continue;
    const desc = sym.signature ?? "";

    for (const pattern of EVENT_SUBSCRIBE_PATTERNS) {
      const regex = new RegExp(`@${pattern}\\s*\\(\\s*['"]([^'"]+)['"](?:\\s*\\))`, "i");
      const match = desc.match(regex);
      if (match) {
        const eventName = match[1];
        const channelId = ensureChannel(eventName, eventName, sym.location.filePath, channelsByKey, sink);
        sink.newRelationships.push(
          makeDataTouchEdge({
            relType: "subscribesTo",
            source: channelId,
            target: sym.id,
            confidence: 0.85,
            reason: `decorator-${pattern}`,
          }),
        );
        sink.counters.eventEdges++;
        break;
      }
    }
  }

  // Pass 2 — emit/publish CALLS.
  for (const rel of relationships) {
    if (rel.relType !== "calls") continue;
    const targetSym = symbolsById.get(rel.target);
    if (!targetSym) continue;
    const calledName = targetSym.name;
    if (!EVENT_PUBLISH_PATTERNS.has(calledName)) continue;

    let topicName = `event:${calledName}`;
    let isAccurate = false;
    // typocop carries any extracted topic in metadata, not a first-class field.
    const channelArgument = rel.metadata?.channelArgument;

    if ((calledName === "add" || calledName === "enqueue") && !channelArgument) {
      continue; // skip ambiguous BullMQ-ish methods unless a topic was extracted.
    }
    if (typeof channelArgument === "string" && channelArgument) {
      topicName = channelArgument;
      isAccurate = true;
    }

    const channelKey = isAccurate ? topicName : `${calledName}_from_${rel.source}`;
    const sourceSym = symbolsById.get(rel.source);
    const channelId = ensureChannel(
      channelKey,
      topicName,
      targetSym.location.filePath,
      channelsByKey,
      sink,
    );
    if (!sourceSym) continue;

    sink.newRelationships.push(
      makeDataTouchEdge({
        relType: "publishesEvent",
        source: rel.source,
        target: channelId,
        confidence: isAccurate ? 1.0 : 0.6,
        reason: isAccurate ? "ast-extracted-topic" : "emit-call-heuristic",
      }),
    );
    sink.counters.eventEdges++;
  }
}
