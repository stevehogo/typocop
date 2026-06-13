Part of the [Data Flow Discovery Design](./design.md).

# Components & Interfaces

## Component 1: DataTouchDetector (`src/indexer/data-touch/detector.ts`)

Detects data-aware nodes (APIEndpoint, DBModel, EventChannel) and creates data-aware relationships in the graph during indexing.

```typescript
interface DataTouchResult {
  readonly apiEndpoints: number;
  readonly dbModels: number;
  readonly eventChannels: number;
  readonly routeEdges: number;
  readonly dbEdges: number;
  readonly eventEdges: number;
}

function detectDataTouches(
  graphAdapter: GraphAdapter,
  onProgress?: (message: string, progress: number) => void,
): Promise<DataTouchResult>;
```

Responsibilities: Query Symbol nodes for route handler decorator/description patterns. Create APIEndpoint nodes (NestJS/Express/Spring/Laravel/FastAPI/Django). Create DBModel nodes (TypeORM, Prisma, Mongoose, Eloquent). Create EventChannel nodes (pub/sub). Create HANDLES_ROUTE, WRITES_TO_DB, READS_FROM_DB, PUBLISHES_EVENT, SUBSCRIBES_TO edges.

## Component 2: DataFlowAssembler (`src/indexer/data-touch/assembler.ts`)

BFS-traces end-to-end data flows from entry points, deduplicates, creates DataFlow nodes with STEP_IN_FLOW edges.

```typescript
interface DataFlowConfig {
  readonly maxTraceDepth: number;   // default: 12
  readonly maxBranching: number;    // default: 4
  readonly maxFlows: number;        // default: 200
  readonly minSteps: number;        // default: 2
}

interface DataFlowAssemblyResult {
  readonly stats: {
    readonly totalFlows: number;
    readonly avgStepCount: number;
    readonly endpointsTraced: number;
    readonly dbModelsReached: number;
  };
}

function assembleDataFlows(
  graphAdapter: GraphAdapter,
  config?: Partial<DataFlowConfig>,
  onProgress?: (message: string, progress: number) => void,
): Promise<DataFlowAssemblyResult>;
```

Responsibilities: Build forward adjacency from CALLS + data-aware edges. Find entry points (APIEndpoint handlers, high-score functions). BFS trace with depth/branching/flow limits. Deduplicate by entry+terminal (prefer DB-touching, longer). Create DataFlow nodes + STEP_IN_FLOW edges.

## Component 3: DataFlowDiscoveryQuery (`src/query/data-flow-discovery.ts`)

Query-time logic for discovering and filtering DataFlow nodes.

```typescript
interface DataFlowFilter {
  readonly httpMethod?: string;
  readonly pathPattern?: string;
  readonly dbTable?: string;
  readonly domainConcept?: string;
}

interface DiscoveredFlow {
  readonly id: string;
  readonly name: string;
  readonly httpMethod?: string;
  readonly httpPath?: string;
  readonly dbTables: string[];
  readonly stepCount: number;
  readonly dataEntities: string[];
  readonly trace: Array<{
    readonly step: number;
    readonly symbolId: string;
    readonly symbolName: string;
    readonly filePath: string;
    readonly kind: string;
  }>;
}

interface DataFlowDiscoveryResult {
  readonly resolution: { readonly kind: "success" } | { readonly kind: "no_flows" };
  readonly flows: DiscoveredFlow[];
  readonly stats: { readonly totalFlows: number; readonly matchedFlows: number; readonly avgStepCount: number; };
  readonly confidence: number;
  readonly riskLevel: RiskLevel;
}

function executeDataFlowDiscovery(
  filter: DataFlowFilter, maxResults: number, graphAdapter: GraphAdapter,
): Promise<DataFlowDiscoveryResult>;
```

## Component 4: MCP Tool Registration

Register `discover_data_flows` in `src/mcp/registration.ts` and handler in `src/mcp/tools.ts`.

```typescript
{
  name: "discover_data_flows",
  description: "Discover all data flows in the codebase. Returns end-to-end flows from API endpoints through services to database models.",
  inputSchema: {
    type: "object",
    properties: {
      httpMethod: { type: "string", description: "Filter by HTTP method" },
      pathPattern: { type: "string", description: "Filter by URL path pattern" },
      dbTable: { type: "string", description: "Filter by database table" },
      domainConcept: { type: "string", description: "Filter by domain concept" },
      maxResults: { type: "number", description: "Max flows to return (default: 50)" },
    },
    required: [],
  },
}
```

## Error Handling

| Scenario | Response | Recovery |
|----------|----------|----------|
| No data touch points found | Zero counts / `no_flows` | Normal — codebase may lack patterns |
| Graph adapter failure | Propagate to pipeline (Req 3.7) | Retry with backoff (max 3) |
| BFS exceeds limits | Config caps output | Graceful degradation |
| Cypher injection in filters | Parameterized queries | Structurally prevented |
