# Requirements Document

## Introduction

The query engine exposes a `RiskLevel` type with four values: `"low"`, `"medium"`, `"high"`, and `"critical"`. The `"critical"` level is defined in the type system and documented in the data models spec but is never returned. The `calculateRiskLevel` function in `execute-query.ts` ignores its `_symbols` parameter entirely, and the equivalent logic in `impact-analysis.ts` uses only symbol name patterns (auth, payment, etc.) without consulting cluster category data already stored in Neo4j.

This feature completes the CRITICAL risk detection path by making both code paths inspect cluster category — specifically `"authentication"` and `"dataAccess"` — in addition to symbol name patterns, and by aligning the two implementations so they produce consistent results.

## Glossary

- **Risk_Calculator**: The module responsible for computing a `RiskLevel` from a set of affected symbols and their cluster metadata.
- **Core_Component**: A symbol that belongs to a cluster categorised as `authentication` or `dataAccess`, or whose name matches a core-component pattern (auth, payment, checkout, security, session, token).
- **ClusterCategory**: The `"authentication" | "dataAccess" | "businessLogic" | "uiComponent" | "utility" | "unknown"` union defined in `src/types/index.ts`.
- **Affected_Symbols**: The list of `Symbol` objects produced by an impact analysis or smart search query that are downstream of the changed symbol.
- **Cluster_Context**: The `Cluster[]` associated with a query result, carrying `category` and `symbols` fields sourced from Neo4j.

## Requirements

### Requirement 1: CRITICAL risk when core components are affected

**User Story:** As an AI editor using the MCP tool, I want the risk level to be `"critical"` whenever a change touches authentication or payment infrastructure, so that I can warn the developer before proceeding.

#### Acceptance Criteria

1. WHEN the Affected_Symbols list contains at least one Core_Component, THE Risk_Calculator SHALL return `"critical"` regardless of the total symbol count.
2. WHEN no Affected_Symbols are Core_Components, THE Risk_Calculator SHALL NOT return `"critical"`.
3. THE Risk_Calculator SHALL classify a symbol as a Core_Component when the symbol belongs to a Cluster whose `category` is `"authentication"` or `"dataAccess"`.
4. THE Risk_Calculator SHALL classify a symbol as a Core_Component when the symbol's `name` matches any of the patterns: `auth`, `payment`, `checkout`, `security`, `session`, `token` (case-insensitive substring match).
5. WHEN both cluster-category and name-pattern signals are available, THE Risk_Calculator SHALL treat either signal as sufficient to classify a symbol as a Core_Component.

### Requirement 2: Count-based thresholds for non-critical results

**User Story:** As an AI editor, I want consistent low/medium/high thresholds when no core components are involved, so that the risk level accurately reflects blast radius.

#### Acceptance Criteria

1. WHEN no Core_Components are present and the Affected_Symbols count is 0 or greater than 0 but no more than 2, THE Risk_Calculator SHALL return `"low"`.
2. WHEN no Core_Components are present and the Affected_Symbols count is between 3 and 10 inclusive, THE Risk_Calculator SHALL return `"medium"`.
3. WHEN no Core_Components are present and the Affected_Symbols count is 11 or greater, THE Risk_Calculator SHALL return `"high"`.

### Requirement 3: Consistent risk calculation across query paths

**User Story:** As a developer maintaining the query engine, I want both `calculateRiskLevel` in `execute-query.ts` and `calculateImpactRisk` in `impact-analysis.ts` to use the same detection logic, so that the same symbol set always produces the same risk level regardless of which query path is taken.

#### Acceptance Criteria

1. THE Risk_Calculator SHALL expose a single shared function that both `execute-query.ts` and `impact-analysis.ts` invoke for risk level computation.
2. WHEN the same Affected_Symbols and Cluster_Context are passed to the shared function, THE Risk_Calculator SHALL return the same RiskLevel on every invocation (deterministic).
3. THE Risk_Calculator SHALL accept the Cluster_Context as an explicit parameter so that callers can supply cluster data retrieved from Neo4j without the function performing its own graph queries.
4. IF the Cluster_Context is empty or unavailable, THEN THE Risk_Calculator SHALL fall back to name-pattern matching only and SHALL NOT return an error.
