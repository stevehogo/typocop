/**
 * `what_publishes_to` / `what_subscribes_to` MCP tools (Wave 8 · T5).
 *
 * Given an event topic, list the code symbols that publish to / subscribe to it
 * via the persisted `PUBLISHES_EVENT` / `SUBSCRIBES_TO` edges.
 *
 * Strictly read-only. DEGRADE-TO-EMPTY: the event SUB-FLAG
 * (`TYPOCOP_DATA_TOUCH_EVENTS`) defaults OFF even when `TYPOCOP_DATA_TOUCH` is on,
 * so these can legitimately be empty on a fully-indexed graph. Empty rows → a
 * clear empty result (`symbols: []`, low confidence, a "may be disabled" summary)
 * — never an error.
 */
import type { DatabaseAdapter } from "../../core/ports/persistence.js";
import type { MCPToolResponse } from "../../core/domain.js";
import { findEventParticipants, type EventDirection } from "../../application/querying/event-channel.js";

/**
 * Execute an event-channel MCP tool. `direction` selects PUBLISHES_EVENT vs
 * SUBSCRIBES_TO; shared by `what_publishes_to` (`publishers`) and
 * `what_subscribes_to` (`subscribers`).
 */
export async function executeEventChannel(
  params: Record<string, unknown>,
  adapter: DatabaseAdapter,
  direction: EventDirection,
): Promise<MCPToolResponse> {
  const topic = typeof params.topic === "string" ? params.topic : "";
  const maxResults = typeof params.maxResults === "number" ? params.maxResults : undefined;

  const graph = adapter.getGraphAdapter();
  const result = await findEventParticipants(graph, topic, direction, {
    ...(maxResults ? { maxResults } : {}),
  });

  const verb = direction === "publishers" ? "publish to" : "subscribe to";
  const noun = direction === "publishers" ? "publisher" : "subscriber";
  const shown = result.participants.length;
  const cappedNote = result.totalFound > shown ? ` (showing first ${shown} of ${result.totalFound})` : "";
  const summary = shown === 0
    ? `No code found that ${verb} event '${result.topic}' (event indexing is OFF by default — set TYPOCOP_DATA_TOUCH_EVENTS at index time).`
    : `Found ${result.totalFound} ${noun}${result.totalFound === 1 ? "" : "s"} for event '${result.topic}'${cappedNote}.`;

  return {
    symbols: result.participants.map((p) => ({
      id: p.symbol.id,
      name: p.symbol.name,
      kind: p.symbol.kind,
      location: { filePath: p.symbol.location.filePath, startLine: p.symbol.location.startLine },
      relationship: direction === "publishers" ? "publishes-event" : "subscribes-event",
      ...(p.confidence !== undefined ? { edgeConfidence: p.confidence } : {}),
    })),
    clusters: [],
    processes: [],
    confidence: shown === 0 ? 0.3 : 0.8,
    riskLevel: "low",
    affectedFlows: [],
    summary,
    eventChannel: {
      topic: result.topic,
      direction: result.direction,
      participants: result.participants.map((p) => ({
        symbolId: p.symbol.id,
        ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
        ...(p.reason ? { reason: p.reason } : {}),
      })),
      totalFound: result.totalFound,
    },
  };
}
