/**
 * Phase 5: Process tracing.
 *
 * Traces execution flows from entry points through the call graph,
 * recording steps in sequential order and analyzing data flow.
 *
 * Requirements: 3.5, 7.1–7.7
 */
import type { Symbol, Relationship, Process } from "../../../core/domain.js";
import { findEntryPoints, buildCallGraph } from "./entry-points.js";
import { traceAllExecutions } from "./trace.js";
import { analyzeDataFlow, inferProcessName } from "./data-flow.js";

export { findEntryPoints, annotateEntryPoints, buildCallGraph, calculateEntryPointScore } from "./entry-points.js";
export { traceExecution, traceAllExecutions, buildProcessSteps, MIN_PROCESS_STEPS } from "./trace.js";
export { analyzeDataFlow, inferProcessName } from "./data-flow.js";

// ─── Phase 5 entry point ──────────────────────────────────────────────────────

/**
 * Phase 5 — Trace execution processes from entry points.
 *
 * 1. Identify entry point symbols (API endpoints, main functions, controllers).
 * 2. Perform depth-first traversal through the call graph with cycle detection.
 * 3. Record steps in sequential order (0-indexed, no gaps).
 * 4. Analyze data flow between steps.
 * 5. Exclude processes with fewer than 2 steps.
 *
 * Requirements: 3.5, 7.1–7.7
 */
export function traceProcesses(
  symbols: Symbol[],
  relationships: Relationship[],
): Process[] {
  if (symbols.length === 0) return [];

  const symbolMap = new Map<string, Symbol>(symbols.map((s) => [s.id, s]));
  const symbolIds = new Set(symbols.map((s) => s.id));
  const callGraph = buildCallGraph(symbolIds, relationships);

  // Build description map: symbolId → name (used for step descriptions)
  const symbolDescriptions = new Map<string, string>(
    symbols.map((s) => [s.id, s.name]),
  );

  // Step 1: Find entry points (Req 7.1).
  // Reuse the already-built callGraph instead of rebuilding it internally.
  const entryPoints = findEntryPoints(symbols, relationships, callGraph);

  // Step 2 & 3: Trace executions with cycle detection (Req 7.2, 7.3, 7.4)
  const traces = traceAllExecutions(entryPoints, callGraph, symbolDescriptions);

  // Step 4 & 5: Build Process records with data flow (Req 7.5, 7.6, 7.7)
  const processes: Process[] = [];

  for (let idx = 0; idx < traces.length; idx++) {
    const trace = traces[idx];

    // Req 7.6: exclude processes with fewer than 2 steps (already filtered in
    // traceAllExecutions, but guard here for safety)
    if (trace.steps.length < 2) continue;

    const name = inferProcessName(trace.entryPoint, trace.steps, symbolMap);
    const dataFlow = analyzeDataFlow(trace.steps, relationships, symbolMap);

    processes.push({
      id: `process_${idx}_${sanitizeId(trace.entryPoint)}`,
      name,
      entryPoint: trace.entryPoint,
      steps: trace.steps,
      dataFlow,
    });
  }

  return processes;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 24).toLowerCase();
}
