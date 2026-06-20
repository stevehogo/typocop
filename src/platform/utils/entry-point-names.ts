/**
 * Entry-point NAME heuristics (pure, dependency-free).
 *
 * Lives in the platform leaf so it can be shared across application sub-layers
 * without crossing the dependency-cruiser `app-no-sibling` boundary:
 *   - indexing/processes/entry-points.ts (entry-point SCORING) re-exports these.
 *   - querying/dead-code.ts (D6) reuses them to exclude framework/runtime-
 *     invoked symbols from the dead-code candidate list.
 *
 * These patterns recognize names that strongly suggest a symbol is an execution
 * entry point (main/init, route handlers, lifecycle hooks, REST verbs,
 * controllers) — symbols that legitimately have no in-repo callers.
 */
export const ENTRY_POINT_PATTERNS: RegExp[] = [
  /^(main|init|bootstrap|start|run|setup|configure)$/i,
  /^handle[A-Z]/,
  /^on[A-Z]/,
  /Handler$/,
  /Controller$/,
  /^process[A-Z]/,
  /^execute[A-Z]/,
  /^perform[A-Z]/,
  /^dispatch[A-Z]/,
  /^(index|show|store|update|destroy|create|edit)$/,
  /^__invoke$/,
  /^(get|post|put|delete|patch)[A-Z]/,
];

/** True when a symbol name matches an entry-point naming pattern. */
export function isEntryPointName(name: string): boolean {
  return ENTRY_POINT_PATTERNS.some((p) => p.test(name));
}
