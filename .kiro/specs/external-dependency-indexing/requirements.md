# Requirements: External Dependency Indexing

## Introduction

Extends the 6-phase indexing pipeline so that external package imports across all 12 supported languages are indexed as first-class `ExternalDependency` nodes in LadybugDB (Kùzu). This enables `impact_analysis("<any-package>")` to return all internal symbols that depend on that package, with fuzzy/alias matching.

## Requirements

### Requirement EDI-1: External Package Detection

**User Story:** As a developer, I want external package imports to be detected during indexing across all supported languages, so that they are not silently dropped as unresolved imports.

#### Acceptance Criteria

1. WHEN an import hint has a bare specifier (no leading `./` or `../`), THE Resolution Phase SHALL classify it as an external package import
2. WHEN an import hint has a relative path, THE Resolution Phase SHALL NOT classify it as an external package import
3. WHEN an import hint starts with `node:`, THE Resolution Phase SHALL NOT classify it as an external package import
4. WHEN an import hint is a scoped npm package (e.g. `@scope/pkg`), THE Resolution Phase SHALL classify it as an external package import
5. WHEN a PHP import hint uses backslash namespace syntax, THE Resolution Phase SHALL classify it as an external package import
6. WHEN a C/C++ import hint is a system header (e.g. `<stdio.h>`), THE Resolution Phase SHALL NOT classify it as an external package import
7. WHEN a C/C++ import hint is a third-party header, THE Resolution Phase SHALL classify it as an external package import
8. WHEN a Rust import uses `crate::`, `super::`, or `self::` prefix, THE Resolution Phase SHALL NOT classify it as an external package import

### Requirement EDI-2: ExternalDependency Node Creation

**User Story:** As a developer, I want external packages to be stored as graph nodes, so that I can query which symbols depend on them.

#### Acceptance Criteria

1. WHEN an external package import is detected, THE Resolution Phase SHALL create an `ExternalDependencyNode` with a stable ID of the form `ext:{normalizedPackageName}`
2. WHEN the same package is imported from multiple files, THE Resolution Phase SHALL reuse the same node (no duplicates)
3. WHEN an `ExternalDependencyNode` is created, it SHALL store the canonical package name, a list of fuzzy aliases, and the package ecosystem
4. WHEN stored in LadybugDB, THE Graph Adapter SHALL label it with `ExternalDependency`

### Requirement EDI-3: DEPENDS_ON Edge Creation

**User Story:** As a developer, I want internal symbols to be linked to external packages, so that dependency traversal works across the boundary.

#### Acceptance Criteria

1. WHEN an external package import is detected, THE Resolution Phase SHALL create a `dependsOn` relationship from the importing symbol to the `ExternalDependencyNode`
2. WHEN stored in LadybugDB, THE Graph Adapter SHALL create an edge with type `DEPENDS_ON`
3. WHEN an internal import is resolved, THE Resolution Phase SHALL NOT create a `dependsOn` relationship

### Requirement EDI-4: Language-Aware Package Name Normalization

**User Story:** As a developer, I want all import variants of the same package to map to a single node, regardless of language syntax differences.

#### Acceptance Criteria

1. WHEN a JS/TS import path contains a sub-path, THE Resolution Phase SHALL normalize it to the root package name
2. WHEN a scoped npm package import contains a sub-path, THE Resolution Phase SHALL normalize it to the scoped root (`@scope/pkg`)
3. WHEN a PHP import uses backslash namespace syntax, THE Resolution Phase SHALL normalize it to the root vendor namespace
4. WHEN a Java/C# import uses dot-separated syntax, THE Resolution Phase SHALL normalize it to the top-level package segments (first 2 dot-segments)
5. WHEN a Go import uses a VCS module path, THE Resolution Phase SHALL normalize it to the 3-segment module root
6. WHEN a Rust import uses `::` path syntax, THE Resolution Phase SHALL normalize it to the crate name
7. WHEN a C/C++ import is a third-party header, THE Resolution Phase SHALL normalize it to the root directory name

### Requirement EDI-5: Fuzzy Alias Matching

**User Story:** As a developer, I want impact analysis to find packages by approximate name, so that I don't need to know the exact package name.

#### Acceptance Criteria

1. WHEN aliases are generated for a package, THE System SHALL include the canonical name, a camelCase variant, a PascalCase variant, and a stripped variant
2. WHEN an impact analysis query matches any alias of an `ExternalDependencyNode`, THE Query Server SHALL treat it as an external dependency query
3. WHEN alias matching is performed, THE Query Server SHALL use case-insensitive substring matching

### Requirement EDI-6: Impact Analysis for External Packages

**User Story:** As a developer, I want `impact_analysis("<package>")` to return all symbols that depend on it, so that I can assess the blast radius of upgrading or replacing the package.

#### Acceptance Criteria

1. WHEN an impact analysis query targets an `ExternalDependencyNode`, THE Query Server SHALL traverse `DEPENDS_ON` edges to find all dependent internal symbols
2. WHEN dependents are found, THE Query Server SHALL apply the same risk level thresholds as for internal symbol impact analysis
3. WHEN an impact analysis query targets an internal symbol, THE Query Server SHALL use the existing traversal logic unchanged

### Requirement EDI-7: Pipeline Integration

**User Story:** As a developer, I want external dependency nodes to be stored automatically during indexing, so that no extra CLI step is needed.

#### Acceptance Criteria

1. WHEN Phase 3 (Resolution) completes, THE Pipeline SHALL include `ExternalDependencyNode` array in the data passed to the graph store
2. WHEN stored, THE Pipeline SHALL also store all associated `DEPENDS_ON` edges
3. WHEN indexing completes, THE CLI Tool SHALL include the count of external dependency nodes in the statistics report

### Requirement EDI-8: Ecosystem Detection

**User Story:** As a developer, I want external packages to be tagged with their ecosystem, so that I can distinguish npm from composer packages in polyglot projects.

#### Acceptance Criteria

1. WHEN a TypeScript or JavaScript file imports an external package, THE System SHALL tag it with ecosystem `npm`
2. WHEN a PHP file imports an external package, THE System SHALL tag it with ecosystem `composer`
3. WHEN a Python file imports an external package, THE System SHALL tag it with ecosystem `pip`
4. WHEN a Java file imports an external package, THE System SHALL tag it with ecosystem `maven`
5. WHEN a Rust file imports an external package, THE System SHALL tag it with ecosystem `cargo`
6. WHEN a Go file imports an external package, THE System SHALL tag it with ecosystem `go_modules`
7. WHEN the ecosystem cannot be determined, THE System SHALL tag the node with ecosystem `unknown`

### Requirement EDI-9: Ruby Import Hint Emission

**User Story:** As a developer, I want Ruby `require` statements to be captured as import hints, so that Ruby external gems are indexed.

#### Acceptance Criteria

1. WHEN a Ruby file contains a `require` or `require_relative` call, THE Parser SHALL emit an import hint with the required path as `targetName`
2. WHEN a Ruby import hint has a relative path, THE Resolution Phase SHALL NOT classify it as external
3. WHEN a Ruby import hint is a bare gem name, THE Resolution Phase SHALL classify it as an external package
