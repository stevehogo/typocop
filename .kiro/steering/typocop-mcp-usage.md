# Typocop MCP Server Usage

The `typocop` MCP server is always available and provides precomputed code graph intelligence for this workspace. It answers questions about symbols, dependencies, and data flows in a single query — no iterative file searches needed.

## When to Use Typocop Tools

**Always prefer typocop tools over manual file reads or grep searches** when you need to:

- Understand what a function/class/method does and how it connects to the rest of the codebase
- Assess the blast radius before modifying, renaming, or deleting a symbol
- Trace how data flows from an API endpoint through services to the database
- Find all callers of a symbol before refactoring it
- Understand which clusters and processes a symbol belongs to

## Available Tools

### `get_symbol_context`
360° view of a symbol: callers, callees, clusters, and processes it belongs to.

```
symbolName: string   (required) — name of the symbol
filePath: string     (optional) — narrow down if name is ambiguous
maxResults: number   (optional, default 50)
```

Use this first when starting work on any task that touches an existing symbol.

### `find_dependents`
All direct and transitive callers of a symbol. Use before any refactor or rename.

```
symbolName: string   (required)
maxDepth: number     (optional) — limit traversal depth
maxResults: number   (optional, default 50)
```

### `trace_data_flow`
Traces execution from an API endpoint through services down to database models.

```
entryPoint: string   (required) — controller method, route handler, etc.
framework: string    (optional) — NestJS, Laravel, Express, etc.
maxResults: number   (optional, default 50)
```

Use when implementing or debugging a feature that spans multiple layers.

### `impact_analysis`
Blast radius analysis: affected symbols, flows, and risk level (LOW/MEDIUM/HIGH/CRITICAL).

```
symbolName: string                          (required)
changeType: "modify" | "delete" | "rename"  (optional, default "modify")
maxResults: number                          (optional, default 50)
```

**Always run this before modifying a shared utility, interface, or core service.**

## Task Execution Workflow

When executing any spec task:

1. Call `get_symbol_context` on the primary symbol(s) the task touches
2. If the task involves modifying an existing symbol, call `impact_analysis` first
3. If the task involves a new API endpoint or data flow, call `trace_data_flow` to understand the existing pattern
4. Use the results to inform implementation — do not re-read files that typocop already covered

## Connection Details

The server connects to an embedded LadybugDB (Kùzu) database stored locally. The default path is `~/.typocop/{prefix}/db.ladybug`.

If a tool call fails with a connection error, the database file may not exist yet (run the indexer first).
