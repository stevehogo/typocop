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
    description: "Get 360° context for a symbol: callers, callees, clusters, and processes",
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
      },
      required: ["symbolName"],
    },
  },
  {
    name: "find_dependents",
    description: "Find all direct and transitive dependents (callers) of a symbol",
    inputSchema: {
      type: "object",
      properties: {
        symbolName: {
          type: "string",
          description: "Name of the symbol to analyze",
        },
        maxDepth: {
          type: "number",
          description: "Maximum traversal depth (default: unlimited)",
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
    description: "Analyze blast radius: affected symbols, flows, and risk level",
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
          description: "Type of change (default: modify)",
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
