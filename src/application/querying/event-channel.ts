/**
 * Event-channel neighbor queries over persisted `PUBLISHES_EVENT` /
 * `SUBSCRIBES_TO` edges (Wave 8 · T5).
 *
 * Given an event topic, resolves it to its `eventchannel:<topic>` node and lists:
 *   - PUBLISHERS — `(publisher:Symbol)-[:PUBLISHES_EVENT]->(channel:Symbol)` (channel is the TARGET).
 *   - SUBSCRIBERS — `(channel:Symbol)-[:SUBSCRIBES_TO]->(subscriber:Symbol)` (channel is the SOURCE; the edge is INVERTED relative to the others — see `events.ts`).
 *
 * Resolution matches EITHER the `eventchannel:<topic>` id OR a channel node whose
 * lower-cased name equals the topic (the heuristic detector names the channel
 * after the extracted topic, but may key it by `<verb>_from_<src>` when the topic
 * is unknown — name match catches the common accurate case).
 *
 * Strictly READ-ONLY. DEGRADE-TO-EMPTY: the event SUB-FLAG
 * (`TYPOCOP_DATA_TOUCH_EVENTS`) defaults OFF even when `TYPOCOP_DATA_TOUCH` is on,
 * so these queries can be empty on a fully-indexed graph; and when the DB's schema
 * predates the event REL tables (table absent, not just empty), `runCypherTolerant`
 * turns the binder "Table does not exist" error into an empty result. Either way →
 * a clear empty result, never an error.
 */
import type { GraphAdapter } from "../../core/ports/persistence.js";
import type { Symbol } from "../../core/domain.js";
import { graphNodeToSymbol, rowToNode, runCypherTolerant } from "./graph-helpers.js";
import type { CypherNodeRow } from "./graph-helpers.js";

/** Which side of the event channel to enumerate. */
export type EventDirection = "publishers" | "subscribers";

/** One code symbol on the channel, plus the edge provenance. */
export interface EventParticipant {
  readonly symbol: Symbol;
  /** `[0,1]` confidence of the event edge, when present. */
  readonly confidence?: number;
  /** The edge's `reason` provenance string (e.g. `decorator-OnEvent`), when present. */
  readonly reason?: string;
}

/** Result of a {@link findEventParticipants} query. */
export interface EventChannelResult {
  /** The topic that was queried (echoed back). */
  readonly topic: string;
  /** `publishers` → PUBLISHES_EVENT, `subscribers` → SUBSCRIBES_TO. */
  readonly direction: EventDirection;
  readonly participants: readonly EventParticipant[];
  /** Total participants found BEFORE the maxResults cap. */
  readonly totalFound: number;
}

/** Row shape: the projected participant node `n` + the edge props. */
interface EventRow extends CypherNodeRow {
  confidence: string | number | null;
  reason: string | null;
}

const DEFAULT_MAX_RESULTS = 100;
/** Synthetic event-channel id prefix (mirrors data-touch `EVENT_CHANNEL_ID_PREFIX`). */
const EVENT_CHANNEL_ID_PREFIX = "eventchannel:";

/** Parse a STRING/number confidence prop into a clamped `[0,1]` number, or undefined. */
function parseConfidence(raw: string | number | null): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const n = typeof raw === "number" ? raw : parseFloat(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(1, n));
}

/**
 * List the publishers OR subscribers of an event `topic`.
 *
 * @param graph     graph adapter
 * @param topic     event topic / channel name
 * @param direction `publishers` (PUBLISHES_EVENT) or `subscribers` (SUBSCRIBES_TO)
 * @param options   optional `maxResults` cap
 */
export async function findEventParticipants(
  graph: GraphAdapter,
  topic: string,
  direction: EventDirection,
  options: { readonly maxResults?: number } = {},
): Promise<EventChannelResult> {
  const maxResults = options.maxResults && options.maxResults > 0 ? options.maxResults : DEFAULT_MAX_RESULTS;
  const trimmed = topic.trim();
  const channelId = `${EVENT_CHANNEL_ID_PREFIX}${trimmed}`;
  const loweredTopic = trimmed.toLowerCase();

  // Bare labels/types — the adapter prefixes them. Edge DIRECTION differs:
  //   PUBLISHES_EVENT: publisher -> channel (channel is the TARGET).
  //   SUBSCRIBES_TO:   channel -> subscriber (channel is the SOURCE; inverted).
  // The participant node is always projected as `n`.
  const cypher = direction === "publishers"
    ? `MATCH (s:Symbol)-[e:PUBLISHES_EVENT]->(c:Symbol)
       WHERE c.id = $channelId OR toLower(c.name) = $topic
       RETURN DISTINCT s AS n, e.confidence AS confidence, e.reason AS reason`
    : `MATCH (c:Symbol)-[e:SUBSCRIBES_TO]->(s:Symbol)
       WHERE c.id = $channelId OR toLower(c.name) = $topic
       RETURN DISTINCT s AS n, e.confidence AS confidence, e.reason AS reason`;

  const rows = await runCypherTolerant<EventRow>(graph, cypher, { channelId, topic: loweredTopic });

  const participants: EventParticipant[] = [];
  for (const row of rows) {
    if (!row?.n?.properties) continue;
    participants.push({
      symbol: graphNodeToSymbol(rowToNode(row)),
      ...(parseConfidence(row.confidence) !== undefined ? { confidence: parseConfidence(row.confidence) } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
    });
  }

  return {
    topic: trimmed,
    direction,
    participants: participants.slice(0, maxResults),
    totalFound: participants.length,
  };
}
