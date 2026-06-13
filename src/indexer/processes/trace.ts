/**
 * Phase 5 — Execution flow tracing.
 *
 * Performs depth-first traversal from entry points through the call graph,
 * detecting cycles and recording steps in sequential order.
 *
 * Requirements: 3.5, 7.2, 7.3, 7.4, 7.6
 */
import type { ProcessStep } from "../../core/domain.js";
import type { CallGraph } from "./entry-points.js";
import { MAX_TRAVERSAL_DEPTH } from "../../platform/utils/limits.js";

// ─── Configuration ────────────────────────────────────────────────────────────

/** Maximum branches to follow per node during tracing. */
const MAX_BRANCHING = 4;

/** Minimum number of steps for a process to be kept (Req 7.6). */
export const MIN_PROCESS_STEPS = 2;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TraceResult {
  /** Ordered symbol IDs forming the execution path. */
  readonly path: readonly string[];
  /** True when a cycle was detected during traversal (Req 7.3). */
  readonly cyclic: boolean;
}

// ─── Depth-first traversal ────────────────────────────────────────────────────

/**
 * Recursively trace execution from a starting symbol through the call graph.
 *
 * - Uses a `visited` set to detect cycles (Req 7.3).
 * - Terminates at max depth or when no more callees exist.
 * - Returns the longest non-cyclic path found.
 *
 * Requirements: 7.2, 7.3
 */
function dfsTrace(
  currentId: string,
  callGraph: CallGraph,
  visited: Set<string>,
  depth: number,
): TraceResult {
  if (depth >= MAX_TRAVERSAL_DEPTH) {
    return { path: [currentId], cyclic: false };
  }

  const callees = callGraph.get(currentId);
  if (!callees || callees.size === 0) {
    return { path: [currentId], cyclic: false };
  }

  // Take up to MAX_BRANCHING callees, pick the one yielding the longest path
  const candidates = Array.from(callees).slice(0, MAX_BRANCHING);
  let bestPath: readonly string[] = [currentId];
  let isCyclic = false;

  for (const calleeId of candidates) {
    if (visited.has(calleeId)) {
      // Cycle detected — terminate this branch (Req 7.3)
      isCyclic = true;
      continue;
    }

    visited.add(calleeId);
    const sub = dfsTrace(calleeId, callGraph, visited, depth + 1);
    visited.delete(calleeId);

    const candidate = [currentId, ...sub.path];
    if (candidate.length > bestPath.length) {
      bestPath = candidate;
      if (sub.cyclic) isCyclic = true;
    }
  }

  return { path: bestPath, cyclic: isCyclic };
}

// ─── Step creation ────────────────────────────────────────────────────────────

/**
 * Convert an ordered path of symbol IDs into ProcessStep records.
 * Steps are 0-indexed with no gaps (Req 7.4).
 */
export function buildProcessSteps(
  path: readonly string[],
  symbolDescriptions: Map<string, string>,
): ProcessStep[] {
  return path.map((symbolId, order) => ({
    order,
    symbolId,
    description: symbolDescriptions.get(symbolId) ?? symbolId,
  }));
}

// ─── Trace execution ──────────────────────────────────────────────────────────

export interface ExecutionTrace {
  readonly entryPoint: string;
  readonly steps: ProcessStep[];
  readonly cyclic: boolean;
}

/**
 * Trace execution from a single entry point through the call graph.
 *
 * Returns undefined when the resulting path has fewer than MIN_PROCESS_STEPS
 * (Req 7.6).
 *
 * Requirements: 7.2, 7.3, 7.4, 7.6
 */
export function traceExecution(
  entryPointId: string,
  callGraph: CallGraph,
  symbolDescriptions: Map<string, string>,
): ExecutionTrace | undefined {
  const visited = new Set<string>([entryPointId]);
  const result = dfsTrace(entryPointId, callGraph, visited, 0);

  if (result.path.length < MIN_PROCESS_STEPS) {
    return undefined;
  }

  const steps = buildProcessSteps(result.path, symbolDescriptions);
  return {
    entryPoint: entryPointId,
    steps,
    cyclic: result.cyclic,
  };
}

/**
 * Trace execution from all entry points, filtering out short processes.
 *
 * Requirements: 7.2, 7.3, 7.4, 7.6
 */
export function traceAllExecutions(
  entryPoints: string[],
  callGraph: CallGraph,
  symbolDescriptions: Map<string, string>,
): ExecutionTrace[] {
  const traces: ExecutionTrace[] = [];
  const seenPaths = new Set<string>();

  for (const entryId of entryPoints) {
    const trace = traceExecution(entryId, callGraph, symbolDescriptions);
    if (!trace) continue;

    // Deduplicate by path signature
    const pathKey = trace.steps.map((s) => s.symbolId).join("->");
    if (seenPaths.has(pathKey)) continue;
    seenPaths.add(pathKey);

    traces.push(trace);
  }

  return traces;
}
