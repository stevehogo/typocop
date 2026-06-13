# Design Document: External Dependency Indexing

## Overview

Currently `impact_analysis("<package>")` returns 0 results for external packages because they are not indexed as graph nodes — only internal code symbols are. This feature indexes external packages as first-class `ExternalDependency` nodes during Phase 3 (Resolution) across all 12 supported languages, creates `DEPENDS_ON` edges from internal symbols to those nodes, and extends impact analysis to traverse those edges. Fuzzy/alias matching lets approximate names resolve to the canonical package.

**Related documents:**
- [Data Models & Algorithms](./design-data-models.md)
- [Correctness Properties](./design-correctness.md)

## Architecture

Change spans five layers: parser, resolution, graph store, query engine, and export.

```mermaid
graph TD
    P2[Phase 2: Parsing<br/>emits hints with language field] --> P3[Phase 3: Resolution]
    P3 --> ExtDetect[isExternalPackage&#40;path, language&#41;]
    ExtDetect -->|external| Norm[normalizePackageName&#40;path, language&#41;]
    Norm --> ExtNode[ExternalDependencyNode<br/>id: ext:packageName]
    ExtDetect -->|internal| InternalRel[Existing IMPORTS edge]
    ExtNode --> DEPENDS_ON[DEPENDS_ON edge]
    ExtNode --> DB[(LadybugDB)]
    DEPENDS_ON --> DB
    QE[Query Engine] --> Lookup[findExternalDependencyByAlias]
    Lookup --> Traverse[MATCH &#40;n&#41;-[:DEPENDS_ON]->&#40;ext&#41; RETURN n]
    Traverse --> DB
    OE[Obsidian Export] --> FetchExt[Fetch ExternalDependency nodes]
    FetchExt --> DB
```

## Files Changed — Complete Inventory

### New files
| File | Purpose |
|---|---|
| `src/indexer/resolution/external-packages.ts` | Core detection, normalization, alias, ecosystem logic |
| `src/indexer/resolution/external-packages.pbt.test.ts` | Property-based tests (EDI-P1 through EDI-P13) |

### Modified files
| File | Change |
|---|---|
| `src/types/index.ts` | Add `PackageEcosystem`, `ExternalDependencyNode`, extend `RelationType` |
| `src/parser/extract-symbols.ts` | Add `language: Language` field to `RawRelationshipHint` |
| `src/parser/queries.ts` | Add `require`/`require_relative` captures to `RUBY_QUERIES` |
| `src/indexer/resolution/index.ts` | Intercept external imports in `resolveHints`, return `ResolveHintsResult`; update `resolveReferences` return type |
| `src/indexer/pipeline.ts` | Capture `extNodes`, store them, add `externalDependencyCount` to `PipelineResult` |
| `src/db/ladybug-graph-adapter.ts` | Add `ExternalDependency` node table, `DEPENDS_ON` rel table, update `REL_LABEL_MAP` |
| `src/db/remote-graph-adapter.ts` | No code change needed (generic), but verify `DEPENDS_ON` works through gRPC |
| `src/cli/executor.ts` | Clear `ExternalDependency` nodes and `DEPENDS_ON` edges on `--refresh`; show ext dep count in stats |
| `src/query/impact-analysis.ts` | Add `findExternalDependencyByAlias`; check before `findDependents` |
| `src/query/context-retrieval.ts` | Add `DEPENDS_ON` traversal to show external deps in 360° view |
| `src/mcp/tools.ts` | Update summary text when result comes from external dep match |
| `src/obsidian-export/graph-reader.ts` | Fetch `ExternalDependency` nodes and `DEPENDS_ON` edges; add to `GraphData` |
| `src/obsidian-export/renderer.ts` | Render external dependency files in vault |
| `src/utils/limits.ts` | Add `C_SYSTEM_HEADERS` and `GO_VCS_HOSTS` constants |

## Error Handling

- `storeExternalDependencies` failure: log warning, continue — best-effort enrichment
- `findExternalDependencyByAlias` returning null: fall back to `findDependents` — no regression
- Unknown language in `isExternalPackage`: default to `true` (safe over-classification)
