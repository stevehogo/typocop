# How to Use Typocop

A practical guide covering database setup, CLI commands, MCP integration, and real-world scenarios.

---

## 1. Start the Database Servers

Typocop requires Neo4j (graph) and PostgreSQL with pgvector (vector search). The easiest way is Docker Compose:

```bash
docker compose up -d
```

This starts:
- Neo4j at `bolt://localhost:8687` (browser UI at http://localhost:8474)
- PostgreSQL at `localhost:8432` (database: `typocop`)

Default credentials are `neo4j/password` and `postgres/password`. Override them with environment variables:

```bash
NEO4J_PASSWORD=mysecret POSTGRES_PASSWORD=mysecret docker compose up -d
```

Wait for both services to be healthy before proceeding:

```bash
docker compose ps   # both should show "healthy"
```

---

## 2. Configure Environment

Create a `.env` file in the project root (never commit this):

```bash
NEO4J_URI=bolt://localhost:8687
NEO4J_USER=neo4j
NEO4J_PASSWORD=password

POSTGRES_URI=postgresql://postgres:password@localhost:8432/typocop

OPENAI_API_KEY=sk-...        # required for semantic search + AI enrichment
MCP_AUTH_TOKEN=your-token    # required for MCP server authentication
```

---

## 3. Build

```bash
pnpm install
pnpm build
```

---

## 4. CLI Reference

All commands run via:

```bash
node dist/cli/index.js <command> [options]
```

### `parse` — Index a codebase

```bash
node dist/cli/index.js parse --path <dir> --lang <language> [--verbose]
```

| Flag | Description |
|------|-------------|
| `--path` | Root directory to index |
| `--lang` | Language: `typescript`, `javascript`, `php`, `python`, `java`, `go`, `rust`, `c`, `cpp`, `csharp`, `ruby`, `swift` |
| `--verbose` | Show per-file progress |

### `status` — Check index state

```bash
node dist/cli/index.js status
```

Shows symbol count, relationship count, cluster count, and last indexed timestamp.

### `reindex` — Re-run the full pipeline

```bash
node dist/cli/index.js reindex
```

Clears the existing graph and re-indexes from scratch. Use after large refactors.

---

## 5. MCP Server

The MCP server exposes Typocop's query engine to AI editors (Kiro, Claude, Cursor, Windsurf).

### Start the server

```bash
node dist/mcp/index.js
```

### Configure in your editor

Add to `.kiro/settings/mcp.json` (or your editor's MCP config):

```json
{
  "mcpServers": {
    "code-graph-analyzer": {
      "command": "node",
      "args": ["dist/mcp/index.js"],
      "env": {
        "NEO4J_URI": "bolt://localhost:8687",
        "NEO4J_USER": "neo4j",
        "NEO4J_PASSWORD": "password",
        "POSTGRES_URI": "postgresql://postgres:password@localhost:8432/typocop",
        "OPENAI_API_KEY": "${OPENAI_API_KEY}",
        "MCP_AUTH_TOKEN": "${MCP_AUTH_TOKEN}"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### Available MCP tools

| Tool | What it does |
|------|-------------|
| `analyze_impact` | What breaks if I change symbol X? |
| `smart_search` | Find execution flows by natural language description |
| `get_context` | 360° view of a symbol — callers, callees, clusters, processes |
| `trace_data_flow` | Trace from API endpoint → services → DB models |
| `pre_commit_check` | Blast radius of uncommitted file changes |

Every tool response includes a `confidence` score (target ≥ 0.90) and a `summary` field ready for the AI to use directly.

---

## 6. Sample Scenarios

### Scenario A: Index a NestJS project and find the auth flow

```bash
# 1. Index the project
node dist/cli/index.js parse --path ./src --lang typescript --verbose

# 2. Check it worked
node dist/cli/index.js status

# 3. In your AI editor, ask via MCP:
# "Trace the data flow for the login endpoint"
# → calls trace_data_flow with entryPoint: "AuthController.login"
```

### Scenario B: Index a Laravel project

```bash
# Index the app directory
node dist/cli/index.js parse --path ./app --lang php --verbose

# In your AI editor:
# "What breaks if I change UserRepository?"
# → calls analyze_impact with target: "UserRepository"
```

### Scenario C: Pre-commit blast radius check

Before committing, ask your AI editor:

> "What's the blast radius of my current changes?"

The MCP `pre_commit_check` tool reads your changed files and returns affected symbols, risk level (`low` / `medium` / `high` / `critical`), and impacted execution flows.

### Scenario D: Find all authentication-related code

In your AI editor:

> "Find everything related to user authentication and session management"

The `smart_search` tool runs a hybrid semantic + keyword search and returns clustered results with confidence scores — no iterative file reads needed.

### Scenario E: Understand an unfamiliar symbol

In your AI editor:

> "Give me full context on the OrderService class"

The `get_context` tool returns callers, callees, which cluster it belongs to, which processes it participates in, and related symbols — all in one response.

---

## 7. Running Tests

```bash
# All tests
pnpm vitest --run

# Minimal output
pnpm vitest --run --reporter=basic

# Specific file
pnpm vitest --run src/indexer/parsing/index.test.ts

# With coverage
pnpm vitest --run --coverage
```

---

## 8. Troubleshooting

**Neo4j connection refused**
- Check `docker compose ps` — neo4j must be `healthy`
- Verify `NEO4J_URI` uses port `8687` (not the default 7687)

**pgvector extension missing**
- The `pgvector/pgvector:pg17` image includes it automatically
- If using your own Postgres: `CREATE EXTENSION IF NOT EXISTS vector;`

**OpenAI errors during indexing**
- Semantic search and AI enrichment require a valid `OPENAI_API_KEY`
- Indexing still works without it — only embedding-based features are disabled

**MCP server not connecting**
- Confirm `MCP_AUTH_TOKEN` matches in both `.env` and your editor's MCP config
- Run `node dist/mcp/index.js` directly and check for startup errors
