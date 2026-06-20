# Graph-Tool Feature Comparison & Adoption Plan

> Analysis date: 2026-06-20. Compares **typocop** against three peer code-graph tools —
> **arbor**, **codebase-memory-mcp (cbm)**, and **GitNexus** — and selects the features
> typocop should adopt. Inventories were produced by reading each repo's README, docs,
> manifests, and source (MCP tool registration, indexing pipeline, schema).

---

## 1. The four tools at a glance

| | **typocop** | **arbor** | **codebase-memory-mcp** | **GitNexus** |
|---|---|---|---|---|
| Language | TypeScript/Node | Rust | Pure C | TypeScript/Node |
| Graph store | **LadybugDB** (Kùzu-compat, Cypher) | petgraph + sled (no query lang) | SQLite (FTS5/BM25) | **LadybugDB** (Cypher) |
| Parser | tree-sitter (12 langs) | tree-sitter (9) + heuristic (5) | tree-sitter (158) + Hybrid-LSP (9) | tree-sitter (13 + Vue/COBOL) |
| Embeddings | HF ONNX / Ollama / none | **none** (n-gram text only) | int8 nomic baked into binary | HF ONNX + remote OpenAI-compat |
| Search | keyword + semantic | n-gram substring | semantic + BM25 + structural + grep | hybrid (BM25+vector via **RRF**) |
| MCP tools | **5** | 3 | 14 | **17** |
| Primary surface | MCP + CLI + gRPC server | CLI + WS + MCP + GUI | MCP + CLI + 3D UI | MCP + CLI + HTTP/web UI |

**Key insight:** GitNexus is built on the *same stack as typocop* (TypeScript + LadybugDB +
tree-sitter + ONNX embeddings + MCP SDK). It is effectively a more mature sibling, so its
features are the **most directly portable**. arbor contributes the best *explainability* and
*CI-gate* ideas; cbm contributes the best *complexity-metrics* and *team-artifact* ideas.

---

## 2. What each peer does that typocop does **not**

### From GitNexus (same stack — cheapest to port)
- **Incremental indexing** with a content-hash parse cache + DB write-back; short-circuits resolution when nothing changed. typocop re-walks and re-writes the *entire* graph every run.
- **Auto-augmenting Claude Code hooks** — a `PreToolUse` hook intercepts the agent's `grep`/`glob`/`bash` searches and injects callers/callees/process context (BM25-only, <500 ms). This makes the graph useful *without* the agent explicitly calling a tool.
- **`detect_changes`** MCP tool — maps a git diff to affected symbols/processes + risk.
- **`trace`** — shortest directed path between two symbols (per-hop file:line + edge type).
- **`rename`** — graph-driven multi-file coordinated rename (preview by default).
- **`check`** — read-only structural check (circular `IMPORTS` cycles) for CI.
- **PDG + interprocedural taint analysis** (`--pdg`): CFG, control-dependence, reaching-defs, source→sink taint with security sink categories.
- **Cross-repo / cross-service groups** — contract registry (HTTP/gRPC/Thrift) cross-linking microservices; `@group` fan-out for query/impact/context.
- **API contract drift** — `shape_check` / `api_impact` compare a route's `.json({...})` response keys against consumer property accesses.
- **9 agent skills** + `AGENTS.md`/`CLAUDE.md` context files installed per-repo.

### From arbor (best explainability + CI ideas)
- **Impact explainability** — every blast-radius entry carries a confidence level + human-readable *reasons* + an `entry_edge` ("*why* is this node in the blast radius") + a **node-role** classification (EntryPoint / Utility / CoreLogic / Isolated / Adapter).
- **Heuristic uncertainty model** — explicitly surfaces edges it *can't* prove statically (callbacks, DI, widget trees) with a confidence score, instead of silently dropping them.
- **CI blast-radius gate** — `arbor check --max-blast-radius N` fails the build (non-zero exit, JSON output) when a change set is too risky. Plus a turnkey **GitHub Action**.
- **`arbor diff`** — preview blast radius of current git changes (rename-aware, ignores whitespace).
- **`arbor audit <sink>`** — reverse path-tracing from a sensitive sink to all public entry points (CVE/security blast radius).
- **Token-budgeted context slicing** — tiktoken-counted, node-pinning context extraction sized to fit an LLM window.
- **PageRank centrality** ranking of nodes ("impact level").

### From codebase-memory-mcp (best analytics + team features)
- **Queryable complexity metrics on every node** — cyclomatic, cognitive, loop depth, and **transitive (interprocedural) loop depth**, recursion flags, "linear scan in loop" — so you can find O(n²) hot paths via a single Cypher query.
- **Team-shared compressed graph artifact** — a zstd-compressed SQLite snapshot committed next to source (`merge=ours`) so teammates skip re-indexing.
- **Dead-code detection** via Cypher (`WHERE NOT EXISTS { (f)<-[:CALLS]-() }`, excluding entry points).
- **IaC indexing** — Dockerfiles, k8s/Kustomize manifests, `compile_commands.json`, env files → `Resource`/`Module` nodes.
- **Git-history co-change edges** (`FILE_CHANGES_WITH`) and `detect_changes` git-diff impact.
- **Leiden community detection** (vs typocop's Louvain) and an **architecture overview** (layers, boundaries, hotspots, entry points).
- **ADR persistence** (`manage_adr`) and **runtime trace ingestion** to validate call edges.
- **3D interactive graph UI** served by an embedded HTTP server.

---

## 3. Features typocop already has (don't re-port)
LadybugDB + Cypher; tree-sitter (12 langs); framework-aware parsing (Magento2, NestJS, Laravel,
Express, Fastify, Spring, FastAPI, Django + generic ORM); hybrid keyword+semantic search;
Louvain clustering with semantic category classification; process/entry-point tracing;
impact analysis with risk levels; symbol resolver with fuzzy "did-you-mean"; data-flow trace;
gRPC connection server with priority scheduler + metrics + **crash resilience**; Obsidian/Mermaid
export; privacy gate on embeddings; property-based invariant tests; strict layered architecture
(dependency-cruiser). **`pre-commit-check.ts` logic already exists** but is *not* exposed via MCP.

---

## 4. Chosen features to implement (prioritized)

Selection criteria: (a) fills a real gap, (b) reinforces typocop's "precomputed intelligence
for AI agents" positioning, (c) feasible on the TS + LadybugDB + tree-sitter stack — GitNexus
proves each is buildable here.

### Tier 1 — Foundational gaps (do first)

1. **Incremental indexing + content-hash parse cache** *(source: GitNexus, arbor, cbm)*
   The single biggest gap. Hash each file (mtime + content), persist per-file parse results,
   re-parse only changed files, and diff nodes/edges instead of delete-all-then-rewrite.
   Unblocks watch mode, fast re-index, and CI usage. **Effort: L. Impact: very high.**

2. **Expose `detect_changes` as an MCP tool** *(source: GitNexus, cbm)*
   The `pre-commit-check.ts` blast-radius logic already exists and is tested — it just needs a
   git-diff→changed-symbol mapping front-end and an MCP registration. Add a thin git layer
   (`simple-git` or shell `git diff --name-only`/hunk parse) → reuse existing impact logic.
   **Effort: S. Impact: high** (also the basis for CI).

3. **Auto-augmenting Claude Code `PreToolUse` hook** *(source: GitNexus)*
   typocop's highest-leverage differentiator: transparently enrich the agent's `grep`/`glob`
   calls with graph context (callers/callees/cluster/process) via a fast BM25-only path
   (<500 ms, fail-silent). Makes the graph valuable even when the agent never calls a tool.
   **Effort: M. Impact: very high.**

### Tier 2 — High-value, moderate effort

4. **Impact-analysis explainability** *(source: arbor)*
   Augment `impact_analysis`/`find_dependents` output with: per-node `entry_edge` ("why in blast
   radius"), confidence + reasons, and a **node-role** label (EntryPoint/Utility/CoreLogic/
   Isolated/Adapter). Pure post-processing over the graph already built. **Effort: M. Impact: high.**

5. **`trace` shortest-path MCP tool** *(source: GitNexus, arbor)*
   Cypher variable-length path between two symbols over CALLS/HAS_METHOD with per-hop file:line.
   Small, high utility for "how does A reach B?". **Effort: S. Impact: medium-high.**

6. **CI risk gate + GitHub Action** *(source: arbor, GitNexus)*
   A `check` command: circular-import cycles (Cypher) + `--max-blast-radius N` threshold against
   `detect_changes`; non-zero exit + JSON; ship a composite GitHub Action. **Effort: M (after #1/#2). Impact: high.**

7. **Token-budgeted context slicing** *(source: arbor)*
   Add a token budget + node-pinning to `get_symbol_context` so results fit a model window
   deterministically (use a tokenizer or a chars≈tokens heuristic). **Effort: M. Impact: medium-high.**

### Tier 3 — Differentiators / bigger bets (plan, then schedule)

8. **Queryable complexity metrics on nodes** *(source: cbm)*
   Compute cyclomatic/cognitive complexity + loop depth during parse, store as Symbol properties,
   expose a "hotspots" query. Cheap signal, strong analytics differentiation. **Effort: M. Impact: medium.**

9. **API contract drift detection** *(source: GitNexus)*
   `shape_check` / `api_impact` — typocop already has framework route parsers, so extracting
   response shapes vs consumer accesses is within reach. **Effort: L. Impact: high for API codebases.**

10. **Coordinated `rename` tool** *(source: GitNexus)*
    Graph-driven high-confidence rename + regex low-confidence fallback, preview by default.
    **Effort: M. Impact: medium.**

11. **Dead-code detection** *(source: cbm)*
    A Cypher-backed query/tool for unreferenced, non-entry-point symbols. **Effort: S. Impact: medium.**

12. **Team-shared graph artifact** *(source: cbm)*
    Compress + commit the LadybugDB index (`.gitattributes merge=ours`) so teammates skip
    re-indexing; pairs with incremental fill-in. **Effort: M. Impact: medium (team workflows).**

### Tier 4 — Large strategic bets (separate RFCs)

13. **PDG + interprocedural taint analysis** *(source: GitNexus)* — CFG/CDG/reaching-defs/taint
    with security sink categories. Opens a security-analysis product line. **Effort: XL.**
14. **Cross-repo / cross-service groups + contract registry** *(source: GitNexus, cbm)* — microservice
    estates; `@group` fan-out for impact/query. **Effort: XL.**
15. **Interactive web visualization** *(source: cbm, arbor)* — beyond static Obsidian/Mermaid.
    **Effort: XL, mostly UX.**

### Explicitly **not** recommended
- **Dropping embeddings / n-gram-only search (arbor model)** — typocop's semantic search is a
  strength; keep it.
- **158-language tree-sitter bundle (cbm)** — diminishing returns; typocop's 12 well-supported
  langs + framework awareness is better positioned.
- **Native desktop GUI / Spotlight protocol (arbor)** — high cost, niche payoff for an MCP-first tool.

---

## 5. Recommended sequencing

```
Phase 1 (foundation)   : #1 incremental index  →  #2 detect_changes MCP  →  watch mode
Phase 2 (agent value)  : #3 auto-augment hook   →  #4 impact explainability  →  #5 trace
Phase 3 (CI + analytics): #6 CI gate + Action   →  #8 complexity metrics  →  #11 dead-code
Phase 4 (differentiate) : #9 API contract drift →  #10 rename  →  #12 team artifact
Phase 5 (strategic RFCs): #13 PDG/taint  /  #14 cross-repo groups  /  #15 web viz
```

Phases 1–2 close typocop's two glaring gaps (no incremental indexing, no transparent agent
integration) and are all proven-feasible on typocop's exact stack by GitNexus.
