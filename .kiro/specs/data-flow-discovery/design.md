# Design Document: Data Flow Discovery Tool

**Related documents:**
- [Components & Interfaces](./design-components.md)
- [Data Models & Algorithms](./design-data-models.md)
- [Correctness Properties & Testing](./design-correctness.md)

## Overview

The Data Flow Discovery tool adds comprehensive data flow analysis to Typocop by introducing a new indexer phase that detects data touch points (API endpoints, DB models, event channels), assembles end-to-end DataFlow nodes via BFS tracing, and exposes a new `discover_data_flows` MCP tool for querying and filtering discovered flows. This replaces the limited `trace_data_flow` tool which only follows CALLS edges and uses regex-based classification.

The system operates at two levels: (1) an indexer phase that runs during the indexing pipeline to detect data-aware relationships (HANDLES_ROUTE, WRITES_TO_DB, READS_FROM_DB, PUBLISHES_EVENT, SUBSCRIBES_TO) and assemble DataFlow nodes with rich metadata, and (2) a query-time MCP tool that discovers, filters, and returns structured flow information including HTTP method/path, DB tables touched, event channels, and step traces.

The design draws from the legacy `data-touch-detector.ts` and `data-flow-processor.ts` implementations, adapted to work with the current Typocop architecture (GraphAdapter/Cypher, 6-phase pipeline, MCP tool registration pattern).

## Architecture

```mermaid
graph TD
    subgraph Indexer Pipeline
        P1[Phase 1: Structure] --> P2[Phase 2: Parsing]
        P2 --> P3[Phase 3: Resolution]
        P3 --> P4[Phase 4: Clustering]
        P4 --> P5[Phase 5: Processes]
        P5 --> P5b["Phase 5b: Data Touch Detection"]
        P5b --> P5c["Phase 5c: Data Flow Assembly"]
        P5c --> P6[Phase 6: Search]
    end

    subgraph Database Layer
        GA[GraphAdapter]
        DB[(LadybugDB / Kùzu)]
        GA --> DB
    end

    subgraph Query Layer
        DFQ[DataFlowDiscoveryQuery]
        SR[SymbolResolver]
        DFQ --> SR
        DFQ --> GA
    end

    subgraph MCP Layer
        REG[Registration]
        TOOLS[Tools]
        REG --> TOOLS
        TOOLS --> DFQ
    end

    P5b -->|createNode, createRelationship| GA
    P5c -->|createNode, createRelationship| GA
```

## Sequence Diagrams

### Indexing: Data Touch Detection & Flow Assembly

```mermaid
sequenceDiagram
    participant Pipeline as Indexer Pipeline
    participant DTD as DataTouchDetector
    participant DFA as DataFlowAssembler
    participant GA as GraphAdapter

    Pipeline->>DTD: detectDataTouches(graphAdapter)
    DTD->>GA: queryNodes("Symbol") — find handlers, entities, events
    GA-->>DTD: Symbol nodes
    DTD->>GA: createNode("APIEndpoint"/"DBModel"/"EventChannel")
    DTD->>GA: createRelationship(HANDLES_ROUTE/WRITES_TO_DB/etc.)
    DTD-->>Pipeline: DataTouchResult

    Pipeline->>DFA: assembleDataFlows(graphAdapter, config)
    DFA->>GA: queryNodes("APIEndpoint") — find entry points
    GA-->>DFA: entry point nodes
    DFA->>GA: runCypher — BFS via data-aware edges
    GA-->>DFA: traced paths
    DFA->>DFA: deduplicateFlows()
    DFA->>GA: createNode("DataFlow") + createRelationship("STEP_IN_FLOW")
    DFA-->>Pipeline: DataFlowAssemblyResult
```

### Query: Discover Data Flows (MCP Tool)

```mermaid
sequenceDiagram
    participant Editor as AI Editor
    participant MCP as MCP Server
    participant DFQ as DataFlowDiscoveryQuery
    participant GA as GraphAdapter

    Editor->>MCP: discover_data_flows({filter})
    MCP->>DFQ: executeDataFlowDiscovery(filter, maxResults, graphAdapter)
    DFQ->>GA: runCypher — query DataFlow nodes with filters
    GA-->>DFQ: DataFlow nodes
    DFQ->>GA: runCypher — get STEP_IN_FLOW edges per flow
    GA-->>DFQ: step details
    DFQ-->>MCP: DataFlowDiscoveryResult
    MCP-->>Editor: MCPToolResponse with flows + summary
```

## Dependencies

- `src/db/types.ts` — `GraphAdapter`, `GraphNode`, `GraphRelationship`
- `src/types/index.ts` — `Symbol`, `RiskLevel`, `MCPToolResponse`
- `src/query/symbol-resolver.ts` — `resolveSymbol` for entry point resolution
- `src/query/graph-helpers.ts` — `rowToNode`, `graphNodeToSymbol`
- `src/query/framework-layers.ts` — `detectFramework` for framework-aware detection
- `src/utils/limits.ts` — `MAX_TRAVERSAL_DEPTH` and resource limits
- `src/mcp/registration.ts` — MCP tool registration pattern
- `src/mcp/tools.ts` — `executeTool` dispatcher and `formatMCPResponse`
- `@modelcontextprotocol/sdk` — MCP server SDK
- `fast-check` — property-based testing (dev dependency)
