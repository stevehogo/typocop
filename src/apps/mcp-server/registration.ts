/**
 * MCP tool and prompt registration.
 * Requirements: 15.1, 15.2
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Tool definitions for MCP server.
 * Requirements: 15.1
 */
const TOOL_DEFINITIONS = [
  {
    name: "get_symbol_context",
    description:
      "Get 360° context for a symbol: callers, callees, clusters, and processes. For a class/interface/method it also returns heritage from the graph: the inheritance chain (ancestors, nearest-first), implemented interfaces, and the methods it overrides / interface methods it satisfies. Note: ancestors are ordered by graph distance, NOT the full C3 MRO (the linearised order + ambiguity diagnostics are not persisted).",
    inputSchema: {
      type: "object",
      properties: {
        symbolName: {
          type: "string",
          description: "Name of the symbol to analyze",
        },
        filePath: {
          type: "string",
          description: "Optional file path to narrow down the symbol",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of results to return (default: 100)",
        },
        tokenBudget: {
          type: "number",
          description: "Optional max estimated tokens for the returned context (D4). When set, slices target + direct callers/callees in BFS order to fit; pinned symbols are always kept. 0 = unlimited.",
        },
        pin: {
          type: "array",
          items: { type: "string" },
          description: "Optional symbol ids to always include in the slice regardless of token budget.",
        },
        maxDepth: {
          type: "number",
          description: "Optional max hop distance for the slice (default: 1 = target + direct neighbours).",
        },
      },
      required: ["symbolName"],
    },
  },
  {
    name: "trace_data_flow",
    description: "Trace data flow from API endpoint through services to database models",
    inputSchema: {
      type: "object",
      properties: {
        entryPoint: {
          type: "string",
          description: "Entry point symbol (API endpoint, controller, etc.)",
        },
        framework: {
          type: "string",
          description: "Optional framework hint (NestJS, Laravel, Express, etc.)",
        },
        minConfidence: {
          type: "number",
          description: "Optional [0,1] floor on data-touch edge confidence: nodes reached via a lower-confidence route/DB edge are dropped. Nodes with no edge confidence (regex-classified) are kept. Omit for no filtering.",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of results to return (default: 100)",
        },
      },
      required: ["entryPoint"],
    },
  },
  {
    name: "impact_analysis",
    description:
      "Blast-radius analysis for a symbol: all direct AND transitive dependents (callers), affected business flows, and a risk level (CRITICAL for auth/payment/checkout/security/session/token code), with each affected node annotated by its structural role, entry edge, and hop distance. Answers both 'who depends on / calls X?' and 'what breaks if I change X?'.",
    inputSchema: {
      type: "object",
      properties: {
        symbolName: {
          type: "string",
          description: "Name of the symbol to analyze",
        },
        changeType: {
          type: "string",
          enum: ["modify", "delete", "rename"],
          description: "Type of change framing for the summary (default: modify)",
        },
        maxDepth: {
          type: "number",
          description: "Maximum traversal depth for transitive dependents (default: unlimited, capped at 20)",
        },
        minConfidence: {
          type: "number",
          description: "Optional [0,1] floor on edge confidence: dependents reached via a lower-confidence edge are dropped. NOTE: CALLS edges carry no confidence today, so this currently prunes nothing on the call graph (forward-compatible).",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of results to return (default: 100)",
        },
      },
      required: ["symbolName"],
    },
  },
  {
    name: "smart_search",
    description: "Find symbols by natural language query using semantic similarity. Use this when you don't know the exact symbol name.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language description" },
        maxResults: { type: "number", description: "Max symbols to return (default: 100)" },
      },
      required: ["query"],
    },
  },
  {
    name: "trace",
    description:
      "Trace the shortest call/containment path between two symbols over CALLS|CONTAINS edges, returning the per-hop chain (symbol, file:line, edge type).",
    inputSchema: {
      type: "object",
      properties: {
        fromSymbol: {
          type: "string",
          description: "Source symbol name or id (start of the path)",
        },
        toSymbol: {
          type: "string",
          description: "Destination symbol name or id (end of the path)",
        },
        maxDepth: {
          type: "number",
          description: "Maximum traversal depth in edges (default + cap: 20)",
        },
      },
      required: ["fromSymbol", "toSymbol"],
    },
  },
  {
    name: "detect_changes",
    description:
      "Detect uncommitted/git changes and analyze their blast radius: affected symbols, business flows, and risk level (elevates to CRITICAL for auth/payment/checkout/security/session/token code).",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["unstaged", "staged", "all", "compare"],
          description:
            "Which diff to analyze: 'unstaged' (working tree vs index, default), 'staged' (index vs HEAD), 'all' (working tree + index vs HEAD), or 'compare' (baseRef...HEAD).",
        },
        baseRef: {
          type: "string",
          description: "Base ref for scope='compare' (e.g. 'main' or a commit SHA).",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of results to return (default: 100)",
        },
      },
      required: [],
    },
  },
  {
    name: "find_dead_code",
    description:
      "List likely-dead-code candidates: symbols with no incoming CALLS edge that are neither exported nor entry-point-named (main/handlers/REST verbs/controllers). Read-only — never deletes. Candidates must be verified before deletion; dynamic/reflective calls are not tracked.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [
            "function", "class", "method", "interface",
            "variable", "import", "export", "type",
          ],
          description: "Optional symbol-kind filter (e.g. 'function', 'method').",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of candidates to return (default: 100)",
        },
      },
      required: [],
    },
  },
  {
    name: "find_hotspots",
    description:
      "List complexity hotspots: the most cyclomatically-complex symbols (cyclomatic = 1 + branch points: if/for/while/case/catch/&&/||/ternary), ranked highest-first and paged. Each result carries cyclomatic, cognitive (nesting-weighted), and maxLoopDepth. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        minComplexity: {
          type: "number",
          description: "Minimum cyclomatic complexity threshold, exclusive (default: 10)",
        },
        maxResults: {
          type: "number",
          description: "Page size cap (default: 50)",
        },
        offset: {
          type: "number",
          description: "Paging offset — number of hotspots to skip (default: 0)",
        },
      },
      required: [],
    },
  },
  {
    name: "rename",
    description:
      "PREVIEW a coordinated symbol rename: resolves the symbol, lists the definition + edge-backed reference sites (CALLS/IMPORTS/REFERENCES) as high-confidence file:line edits, plus a word-boundary regex for the low-confidence text tail. PREVIEW ONLY — never writes files or the graph.",
    inputSchema: {
      type: "object",
      properties: {
        symbolName: {
          type: "string",
          description: "Current name (or id) of the symbol to rename",
        },
        newName: {
          type: "string",
          description: "Proposed new name (must be a valid identifier)",
        },
        filePath: {
          type: "string",
          description: "Optional file path to disambiguate an ambiguous symbol name",
        },
      },
      required: ["symbolName", "newName"],
    },
  },
  {
    name: "shape_check",
    description:
      "Detect API contract drift. With no args: graph-wide — compares the top-level response keys each route returns (res.json/res.send/return {...}) against the keys consumers read, and reports every key a consumer reads that no route returns (confidence 'low' when a consumer's file fetches multiple routes). With 'route': scopes to that route — its blast radius (affected symbols, flows, risk) PLUS the consumer contract mismatches (the former api_impact view). v1: top-level keys only. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        route: {
          type: "string",
          description: "Optional route symbol name (e.g. 'GET /users' or the handler name). Omit for graph-wide drift; provide for one route's drift + blast radius.",
        },
      },
      required: [],
    },
  },
  {
    name: "verify_claim",
    description:
      "Verify a structured belief about the codebase and get back verdict (confirmed/refuted/uncertain) + confidence + evidence — so you stop acting on false assumptions. Claim kinds: 'usage' (needs 'symbol'): 'X has no callers / is dead'. 'edge' (needs 'from','to','relation' ∈ calls|imports|inherits|implements|references|overrides|methodImplements): 'X {relation} Y' (overrides = a subclass method overrides an ancestor's; methodImplements = a method satisfies an interface/trait contract). 'reachability' (needs 'from','to','polarity' ∈ reachable|independent): 'X can reach Y' / 'changing X can't affect Y'. Honest-uncertainty: relationships the graph can't prove (dynamic dispatch/callbacks/DI) return 'uncertain', never a false confirm/refute; a refute includes the true answer. Read-only; never throws.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["usage", "edge", "reachability"],
          description: "Claim class: 'usage' | 'edge' | 'reachability'.",
        },
        symbol: {
          type: "string",
          description: "Subject symbol for a 'usage' claim (name or id).",
        },
        from: {
          type: "string",
          description: "Source symbol for an 'edge' or 'reachability' claim (name or id).",
        },
        to: {
          type: "string",
          description: "Target symbol for an 'edge' or 'reachability' claim (name or id).",
        },
        relation: {
          type: "string",
          enum: ["calls", "imports", "inherits", "implements", "references", "overrides", "methodImplements"],
          description: "Edge type for an 'edge' claim.",
        },
        polarity: {
          type: "string",
          enum: ["reachable", "independent"],
          description:
            "For a 'reachability' claim: 'reachable' (X can reach Y) or 'independent' (changing X can't affect Y).",
        },
      },
      required: ["kind"],
    },
  },
  {
    name: "query_graph",
    description:
      "Run a GUARDED, READ-ONLY Cypher query against the code knowledge graph for questions the canned tools don't cover (e.g. `MATCH (s:Symbol) WHERE NOT (s)<-[:CALLS]-() RETURN s.name`). Write labels BARE (`:Symbol`, `[:CALLS]`) — the schema prefix is added/stripped automatically. STRICTLY READ-ONLY: a single MATCH/OPTIONAL MATCH/WITH/UNWIND/RETURN statement only; any mutation/DDL/procedure (CREATE/MERGE/SET/DELETE/DETACH/REMOVE/DROP/ALTER/CALL/LOAD/COPY/…) or a second statement is rejected before execution. Results are row-capped (default 100, max 200) and time-bounded. Node labels are: Symbol, Cluster, Process, Metadata, ExternalDependency; edge types: CALLS, IMPORTS, INHERITS, IMPLEMENTS, CONTAINS, HAS_STEP, REFERENCES, DEFINES, DEPENDS_ON, OVERRIDES, METHODIMPLEMENTS.",
    inputSchema: {
      type: "object",
      properties: {
        cypher: {
          type: "string",
          description:
            "A single read-only Cypher statement using BARE labels/edge-types (no schema prefix). Must start with MATCH/OPTIONAL MATCH/WITH/UNWIND/RETURN.",
        },
        limit: {
          type: "number",
          description: "Max rows to return (default 100, hard max 200).",
        },
      },
      required: ["cypher"],
    },
  },
  {
    name: "route_map",
    description:
      "List ALL API routes the indexer linked a handler to, via the persisted HANDLES_ROUTE edges — endpoint + serving handler + provenance. Covers decorator (NestJS/Spring), Express/Fastify, and structured framework routes (incl. Laravel resource expansion). Enumerates the route surface — distinct from trace_data_flow (traces FROM one endpoint) and shape_check (response-contract drift). Read-only. Returns an EMPTY result when data-touch indexing was disabled at index time (TYPOCOP_DATA_TOUCH off), not an error.",
    inputSchema: {
      type: "object",
      properties: {
        maxResults: {
          type: "number",
          description: "Maximum number of routes to return (default: 100)",
        },
      },
      required: [],
    },
  },
  {
    name: "what_reads_table",
    description:
      "Given a table/model name, list the code symbols that READ from it via the persisted READS_FROM_DB edges (\"what code reads table X\"). Resolves the table to its dbmodel:<table> synthetic node or a real model class. Keyed on DATA edges, not CALLS — distinct from impact_analysis. Read-only. Returns an EMPTY result when data-touch indexing was disabled at index time, not an error.",
    inputSchema: {
      type: "object",
      properties: {
        table: {
          type: "string",
          description: "Table / model name (case-insensitive), e.g. 'users' or 'User'.",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of symbols to return (default: 100)",
        },
      },
      required: ["table"],
    },
  },
  {
    name: "what_writes_table",
    description:
      "Given a table/model name, list the code symbols that WRITE to it via the persisted WRITES_TO_DB edges (\"what code writes table X\"). Resolves the table to its dbmodel:<table> synthetic node or a real model class. Keyed on DATA edges, not CALLS — distinct from impact_analysis. Read-only. Returns an EMPTY result when data-touch indexing was disabled at index time, not an error.",
    inputSchema: {
      type: "object",
      properties: {
        table: {
          type: "string",
          description: "Table / model name (case-insensitive), e.g. 'users' or 'User'.",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of symbols to return (default: 100)",
        },
      },
      required: ["table"],
    },
  },
  {
    name: "what_publishes_to",
    description:
      "Given an event topic, list the code symbols that PUBLISH to it via the persisted PUBLISHES_EVENT edges. Resolves the topic to its eventchannel:<topic> node. Read-only. Event indexing is OFF by default (TYPOCOP_DATA_TOUCH_EVENTS) even when data-touch is on, so this returns an EMPTY result when events were not indexed — not an error.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Event topic / channel name, e.g. 'order.created'.",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of publishers to return (default: 100)",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "what_subscribes_to",
    description:
      "Given an event topic, list the code symbols that SUBSCRIBE to it via the persisted SUBSCRIBES_TO edges (the handlers a published event reaches). Resolves the topic to its eventchannel:<topic> node. Read-only. Event indexing is OFF by default (TYPOCOP_DATA_TOUCH_EVENTS) even when data-touch is on, so this returns an EMPTY result when events were not indexed — not an error.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Event topic / channel name, e.g. 'order.created'.",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of subscribers to return (default: 100)",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "pdg_query",
    description:
      "Query the per-function program-dependence graph (requires indexing with --pdg). mode:'controls' returns a callable's control-dependence + control-flow block structure; mode:'flows' returns the taint findings whose sink is that callable. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["controls", "flows"], description: "'controls' (PDG control structure) or 'flows' (taint findings into the target)." },
        target: { type: "string", description: "Target callable symbol name or id." },
      },
      required: ["mode", "target"],
    },
  },
  {
    name: "explain",
    description:
      "Explain interprocedural taint findings (source→sink paths) for humans (requires indexing with --pdg). Each finding carries its SinkKind (command|sql|path|xss|code) and whether a sanitizer was on the path. SOUND-BUT-OVER-REPORTING: expect false positives — verify before acting; NEVER auto-act on a finding. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Optional: scope to findings whose sink is this callable (name or id)." },
        limit: { type: "number", description: "Max findings to render (default 50)." },
      },
      required: [],
    },
  },
];

/**
 * Prompt definitions for MCP server.
 * Requirements: 15.2
 */
const PROMPT_DEFINITIONS = [
  {
    name: "analyze_impact",
    description: "Analyze the impact of changing a specific symbol",
    arguments: [
      {
        name: "symbolName",
        description: "Name of the symbol to analyze",
        required: true,
      },
    ],
  },
  {
    name: "trace_flow",
    description: "Trace execution flow from an entry point",
    arguments: [
      {
        name: "entryPoint",
        description: "Entry point symbol name",
        required: true,
      },
    ],
  },
];

/**
 * Register MCP tools with the server.
 * Requirements: 15.1
 */
export function registerTools(server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));
}

/**
 * Register MCP prompts with the server.
 * Requirements: 15.2
 */
export function registerPrompts(server: Server): void {
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPT_DEFINITIONS,
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const promptName = request.params.name;

    if (promptName === "analyze_impact") {
      const symbolName = request.params.arguments?.symbolName as string;
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Analyze the impact of changing the symbol '${symbolName}'. ` +
                `What will break? What flows are affected? What is the risk level?`,
            },
          },
        ],
      };
    }

    if (promptName === "trace_flow") {
      const entryPoint = request.params.arguments?.entryPoint as string;
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Trace the execution flow starting from '${entryPoint}'. ` +
                `Show the complete path from entry point to database models.`,
            },
          },
        ],
      };
    }

    throw new Error(`Unknown prompt: ${promptName}`);
  });
}

/**
 * Create and configure MCP server.
 * Requirements: 15.1, 15.2
 */
export function createMCPServer(): Server {
  const server = new Server(
    {
      name: "typocop-mcp-server",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
      },
    },
  );

  registerTools(server);
  registerPrompts(server);

  return server;
}
