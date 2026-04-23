Part of the [Obsidian Export Design](./design.md).

# Components & Interfaces

## Component 1: CLI Extension

**Purpose**: Register the `obsidian` subcommand in the existing Commander.js CLI.

```typescript
// Extends the CLICommand discriminated union
export type CLICommand =
  | { type: "parse"; config: CLIConfig }
  | { type: "reindex"; dbPath: string }
  | { type: "status" }
  | { type: "obsidian"; config: ObsidianExportConfig };

export interface ObsidianExportConfig {
  readonly outputPath: string;
  readonly verbose: boolean;
}
```

**Responsibilities**:
- Parse `--out` option (default: `./.typocop-obsidian`)
- Parse `--verbose` flag
- Validate output path is writable

## Component 2: GraphReader

**Purpose**: Fetch all graph data from Neo4j in a single read transaction, respecting the configured prefix.

```typescript
export interface GraphData {
  readonly symbols: ExportedSymbol[];
  readonly clusters: ExportedCluster[];
  readonly processes: ExportedProcess[];
  readonly relationships: ExportedRelationship[];
  readonly clusterMemberships: ReadonlyMap<string, string[]>;
  readonly processSteps: ReadonlyMap<string, ExportedProcessStep[]>;
}

export interface ExportedSymbol {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly visibility: string;
  readonly signature: string;
  readonly documentation: string;
}

export interface ExportedCluster {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly confidence: number;
  readonly symbolCount: number;
}

export interface ExportedProcess {
  readonly id: string;
  readonly name: string;
  readonly entryPoint: string;
  readonly stepCount: number;
}

export interface ExportedRelationship {
  readonly sourceId: string;
  readonly targetId: string;
  readonly relType: string;
  readonly sourceName: string;
  readonly targetName: string;
}

export interface ExportedProcessStep {
  readonly order: number;
  readonly symbolId: string;
  readonly symbolName: string;
}

export function fetchAllGraphData(session: Session, prefix: string): Promise<GraphData>;
```

**Responsibilities**:
- Execute Cypher queries to fetch all nodes and relationships
- Resolve symbol names for relationship endpoints
- Build cluster membership and process step maps
- Handle empty graph gracefully (return empty GraphData)

## Component 3: MarkdownRenderer

**Purpose**: Transform GraphData into a map of file paths to markdown content.

```typescript
export interface VaultFile {
  readonly relativePath: string;
  readonly content: string;
}

export interface VaultContent {
  readonly files: VaultFile[];
}

export function renderVault(data: GraphData): VaultContent;
```

**Responsibilities**:
- Group symbols by file path
- Generate per-file markdown with YAML frontmatter and wikilinks
- Generate cluster index files
- Generate process files with Mermaid diagrams
- Generate top-level navigation index

## Component 4: VaultWriter

**Purpose**: Write the rendered vault content to the file system.

```typescript
export interface WriteResult {
  readonly filesWritten: number;
  readonly directoriesCreated: number;
  readonly totalBytes: number;
}

export function writeVault(outputPath: string, content: VaultContent): Promise<WriteResult>;
```

**Responsibilities**:
- Create output directory structure (mirroring source paths)
- Write each markdown file
- Clean existing output directory before writing (fresh export)
- Report statistics
