# Design: Data Models & Algorithms

Part of the [External Dependency Indexing Design](./design.md).

## New Type: ExternalDependencyNode

Added to `src/types/index.ts`:

```typescript
export interface ExternalDependencyNode {
  readonly id: string;        // "ext:{normalizedPackageName}"
  readonly name: string;      // canonical package name
  readonly aliases: readonly string[];
  readonly ecosystem: PackageEcosystem;
}

export type PackageEcosystem =
  | "npm" | "composer" | "pip" | "maven"
  | "cargo" | "go_modules" | "unknown";
```

## Extended RelationType

```typescript
export type RelationType =
  | "calls" | "imports" | "inherits" | "implements"
  | "contains" | "references" | "defines"
  | "dependsOn";   // internal symbol → ExternalDependencyNode
```

## Extended RawRelationshipHint

In `src/parser/extract-symbols.ts` — add `language` field:

```typescript
export interface RawRelationshipHint {
  readonly kind: "import" | "call" | "inherits" | "implements";
  readonly sourceFile: string;
  readonly targetName: string;
  readonly childSymbolId?: string;
  readonly startLine: number;
  readonly language: Language;  // ← NEW
}
```

All hint construction sites in `extractSymbolsWithQueries` must populate `language` from the function parameter.

## LadybugDB Schema Additions

In `initializeSchema()` of `src/db/ladybug-graph-adapter.ts`:

```
CREATE NODE TABLE IF NOT EXISTS {prefix}ExternalDependency (
  id STRING, name STRING, aliases STRING, ecosystem STRING,
  PRIMARY KEY(id)
)
```

```
CREATE REL TABLE IF NOT EXISTS {prefix}DEPENDS_ON (
  FROM {prefix}Symbol TO {prefix}ExternalDependency
)
```

Update `REL_LABEL_MAP`: `DEPENDS_ON: ["Symbol", "ExternalDependency"]`

## Modified resolveHints return type

```typescript
export interface ResolveHintsResult {
  readonly relationships: Relationship[];
  readonly extNodes: Map<string, ExternalDependencyNode>;
}
```

`resolveReferences` also returns `ResolveHintsResult` (breaking change for pipeline caller).

## Modified PipelineResult

```typescript
export interface PipelineResult {
  // ... existing fields ...
  readonly externalDependencyCount: number;  // ← NEW
}
```

## Modified GraphData (Obsidian export)

```typescript
export interface ExportedExternalDependency {
  readonly id: string;
  readonly name: string;
  readonly aliases: string;
  readonly ecosystem: string;
}

export interface GraphData {
  // ... existing fields ...
  readonly externalDependencies: ExportedExternalDependency[];
  readonly dependsOnEdges: ExportedRelationship[];
}
```

## Algorithms

See [design-correctness.md](./design-correctness.md) for property specifications.

### isExternalPackage(importPath, language)

Returns false for: relative paths (`./`, `../`), `node:` built-ins, C system headers, Rust internal paths (`crate::`, `super::`, `self::`). Returns true for everything else.

### normalizePackageName(importPath, language)

Per-language: PHP `\` first segment, Java/C# `.` first 2 segments, Rust `::` first segment, Go 3-segment VCS, C/C++ first `/` segment strip `.h`, TS/JS scoped `@scope/pkg` or first `/` segment.

### buildAliases(packageName)

Canonical + camelCase + PascalCase + stripped (remove `[-_.]`).

### detectEcosystem(language)

TS/JS→npm, PHP→composer, Python→pip, Java→maven, Rust→cargo, Go→go_modules, else→unknown.

### findExternalDependencyByAlias(graph, query)

Case-insensitive match on `name` and comma-separated `aliases` field. Returns first match or null. Falls through to `findDependents` on null.
