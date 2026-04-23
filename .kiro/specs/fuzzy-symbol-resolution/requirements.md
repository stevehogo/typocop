# Requirements: Fuzzy Symbol Resolution

## Requirement 1: Two-Step Symbol Resolution

### Description
All MCP tools that resolve symbols (`get_symbol_context`, `find_dependents`, `trace_data_flow`, `impact_analysis`) must use a two-step resolution strategy: exact match first, then fuzzy CONTAINS fallback.

### Acceptance Criteria
- 1.1 When a symbol name or ID matches exactly in the graph, the tool returns results for that symbol (current behavior preserved).
- 1.2 When no exact match exists but the input is a substring of a symbol name (case-insensitive), the tool falls back to CONTAINS matching and returns results for the best fuzzy match.
- 1.3 The best fuzzy match is the symbol with the shortest name among all CONTAINS matches (closest to the user's input).
- 1.4 Exact match always takes precedence over fuzzy match — if an exact match exists, fuzzy matching is never attempted.
- 1.5 The resolution logic is implemented in a single shared module (`src/query/symbol-resolver.ts`) used by all four tools, eliminating the duplicated `findNode` functions.
- 1.6 The `resolveSymbol` function returns a discriminated union with three variants: `exact`, `fuzzy`, or `not_found`.

## Requirement 2: "Did You Mean?" Suggestions

### Description
When no symbol is found (even after fuzzy matching), the MCP tools must provide "Did you mean?" suggestions in the response summary to guide the user toward the correct symbol name.

### Acceptance Criteria
- 2.1 When `resolveSymbol` returns `not_found`, the tool queries for similar symbol names and includes up to 5 suggestions in the `summary` field.
- 2.2 Suggestions are ranked by Levenshtein edit distance (ascending) — the most similar names appear first.
- 2.3 The `summary` field format for not-found results is: `Symbol '<name>' not found. Did you mean: <suggestion1>, <suggestion2>, ...?`
- 2.4 When no similar symbols exist at all, the summary says: `Symbol '<name>' not found. No similar symbols found.`
- 2.5 The Levenshtein distance implementation is correct: symmetric, identity (distance 0 for equal strings), and non-negative.
- 2.6 The suggestion candidate set is limited to at most 1000 symbol names from the graph to keep response times within the 2-second query timeout.

## Requirement 3: Fuzzy Match Indication in Summary

### Description
When a fuzzy match is used instead of an exact match, the response summary must clearly indicate this so the user knows the result may not be for the exact symbol they requested.

### Acceptance Criteria
- 3.1 When `resolveSymbol` returns `fuzzy`, the `summary` field includes the text `Fuzzy matched '<input>' → '<matchedName>'` to indicate the substitution.
- 3.2 The confidence score for fuzzy-matched results is the same as for exact matches (determined by the downstream query logic, not the resolution step).
- 3.3 All four MCP tools (`get_symbol_context`, `find_dependents`, `trace_data_flow`, `impact_analysis`) include the fuzzy match indicator in their summaries.

## Requirement 4: Framework-Aware Layer Classification

### Description
The `trace_data_flow` tool must replace its hardcoded `LAYER_PATTERNS` with a framework-aware classification system that maps detected frameworks to the 5 trace layers (api, controller, service, repository, model).

### Acceptance Criteria
- 4.1 A `FRAMEWORK_LAYER_MAP` maps framework identifiers to layer-specific regex patterns for at least: NestJS, Spring, Laravel, Express, Django, FastAPI, Next.js, ASP.NET.
- 4.2 When the `framework` parameter is provided to `trace_data_flow`, it is used to select the appropriate layer patterns from the map.
- 4.3 When no `framework` parameter is provided, the framework is auto-detected from the entry point's file path using path-based detection logic derived from the legacy `detectFrameworkFromPath`.
- 4.4 When no framework is detected (neither from hint nor from path), the tool falls back to generic layer patterns that match the current hardcoded `LAYER_PATTERNS` behavior.
- 4.5 The framework detection and layer classification logic is implemented in a separate module (`src/query/framework-layers.ts`), not inline in `data-flow-trace.ts`.
- 4.6 The `classifyLayer` function accepts a `GraphNode` and an optional `frameworkHint` string, returning one of the 6 `TraceLayer` values.

## Requirement 5: Code Quality and Constraints

### Description
All new code must comply with the project's coding standards and constraints.

### Acceptance Criteria
- 5.1 All new source files stay under 250 lines.
- 5.2 No `any` types — use `unknown` and narrow with type guards.
- 5.3 All public functions have explicit return type annotations.
- 5.4 Tests are co-located with source files using vitest + fast-check for property-based tests.
- 5.5 The shared `graphNodeToSymbol` and `rowToNode` helper functions are extracted to a common location to eliminate duplication across `context-retrieval.ts`, `impact-analysis.ts`, and `data-flow-trace.ts`.
