# New Session

Exported: 4/6/2026, 9:37:29 AM

## Steering Documents

**Workspace:**
- package-manager.md
- project-overview.md
- typocop-mcp-usage.md

---

**User:**

chat: use typocop mcp to find what happen when i want to change Neo4j to Memgraph

---

**Assistant:**

Let me run the impact analysis on Neo4j-related symbols to understand the blast radius of switching to Memgraph.

Low confidence, let me try with more specific symbol names from the codebase.

The graph DB might not have indexed these yet. Let me search the codebase directly to find the actual Neo4j-related symbols.

Good, now I have a clear picture. Let me also check the graph connection layer specifically.

Now let me also check the graph write/indexer side and the indexer's Neo4j usage.

That's a clear picture. Here's the full blast radius analysis:

---

**Risk Level: CRITICAL** (92% confidence from typocop)

Changing Neo4j to Memgraph touches every major execution flow in the system. Here's what's affected:

**The good news — Cypher is compatible**

Memgraph is Cypher-compatible, so all the queries in `src/graph/query.ts` and `src/graph/store.ts` (`MATCH`, `MERGE`, `UNWIND`, `HAS_STEP`, `CONTAINS`, etc.) should work without changes. This is the biggest win.

**What you actually need to change:**

`src/graph/connection.ts` — the `createDriver` function is the blast epicenter. It uses `neo4j-driver` to create the Bolt connection. You'd swap this to use Memgraph's driver (which is also Bolt-based, so the API is nearly identical).

`src/mcp/server.ts` — `getDatabaseConfig` reads `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD` env vars and passes them to `createDriver`. You'd rename these env vars and update the default URI from `bolt://localhost:8687` to Memgraph's default `bolt://localhost:7687`.

`src/mcp/session-manager.ts` — imports `Driver` and `Session` types from `neo4j-driver`. These would need to come from the Memgraph driver package instead.

**All the files importing `Session`/`Driver`/`ManagedTransaction` from `neo4j-driver`:**

- `src/graph/store.ts`
- `src/graph/query.ts`
- `src/query/context-retrieval.ts`
- `src/query/impact-analysis.ts`
- `src/query/data-flow-trace.ts`
- `src/query/smart-search.ts`
- `src/query/execute-query.ts`
- `src/query/pre-commit-check.ts`
- `src/query/process-helpers.ts`
- `src/mcp/handler.ts`
- `src/mcp/session-manager.ts`
- `src/query/server.ts`

That's 12 files with type imports, but since Memgraph's JS driver (`@memgraph/neo4j-driver` or the official `neo4j-driver` fork) exposes the same `Driver`/`Session`/`ManagedTransaction` interface, you may only need to change the import source — not the actual usage.

**Test files** — several tests mock `neo4j-driver` types directly (`session-manager.test.ts`, `bug-condition-exploration.test.ts`, `preservation-property.test.ts`, etc.), so those mocks would need the import path updated too.

**Affected execution flows (all of them):**
- `StartMCPServer`
- `ExecuteIndexingPipeline`
- `ExecuteCLI`
- `ReadGraphStatus`
- `Main`

Basically every process in the system flows through `createDriver`, which is why the risk is CRITICAL — not because the change is hard, but because it's load-bearing for everything.

**TL;DR on effort:** The Cypher queries stay the same. The real work is swapping the driver package and updating 12+ import sites. If Memgraph's driver is API-compatible with `neo4j-driver` (it largely is), this could be mostly a find-and-replace on the import path plus env var renaming.

---
