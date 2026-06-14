# Indexing Pipeline gRPC Message-Size Fix Plan

Date: 2026-06-14

Fixes: `RESOURCE_EXHAUSTED: Received message larger than max (10290212 vs 4194304)`
during indexing against a connection-server (remote) database.

Relates to: the batch-write RPC path added for batched persistence
(`GraphAdapter.createNodes/createRelationships`, `VectorAdapter.indexSymbols`).

## Symptom

When indexing writes results to a **remote** LadybugDB connection server, a batch
write RPC carries a ~9.8 MB payload (`10290212` bytes) and the server rejects it on
receive because its limit is exactly 4 MB (`4194304`). The index fails partway through
persistence. Embedded (in-process) indexing is unaffected — this only occurs over gRPC.

## Root Cause

1. **Server caps messages at 4 MB both ways.** `MAX_MESSAGE_BYTES = 4 * 1024 * 1024`
   (= `4194304`) is set as `grpc.max_receive_message_length` and
   `grpc.max_send_message_length` (`src/apps/ladybug-server/server.ts:22,37–40`).
2. **The client sets no channel options.** gRPC clients are built with
   `new constructors.Graph(target, grpc.credentials.createInsecure())` and
   `...Vector(...)` — no options object (`src/infrastructure/remote-transport/remote-grpc.ts:32–33`),
   so the client inherits gRPC-js's default **4 MB receive** limit as well. (Large query
   *responses* will hit this on the client side too — e.g. `queryNodes`/`queryRelationships`
   on a big graph.)
3. **Batches are chunked by row count, not bytes.** `persistence-helpers.ts` splits each
   group with `chunk(rows, DB_WRITE_BATCH_SIZE)` where `DB_WRITE_BATCH_SIZE = 500`
   (`src/platform/utils/limits.ts`), regardless of how large each row serializes
   (`persistence-helpers.ts:62,87,111`).
4. **The whole chunk is serialized into one field.** The remote adapters do
   `JSON.stringify(nodes)` / `JSON.stringify(relationships)` / `JSON.stringify(entries)`
   into a single `*_json` string per RPC
   (`remote-graph-adapter.ts:76,91`, `remote-vector-adapter.ts:69`).

Embeddings dominate the size: a single embedding row is `{symbolId, embedding:{vector:[…768
floats…], dimensions}, metadata}` ≈ ~14–20 KB of JSON, so a 500-row `indexSymbols` chunk is
~7–10 MB — well over 4 MB. Symbol nodes with long `signature`/`documentation` strings can
do the same for `createNodes`. A fixed row count cannot bound the wire size.

## RPC Payload Audit (all connection-server methods)

Audited every RPC in `proto/ladybug_connection.proto` against the 4 MB cap in **both**
directions (request = client→server, gated by server `max_receive`; response =
server→client, gated by server `max_send` *and* client `max_receive`). The original error
is a request-direction failure; the audit also found symmetric **response-direction**
risks not covered by write chunking.

| RPC | Large direction | Risk | Status |
|---|---|---|---|
| `Vector.IndexSymbols` | request (`entriesJson`, embeddings) | **High** — the reported error | Phase A |
| `Graph.CreateNodes` | request (`nodesJson`) | **High** (signature/documentation) | Phase A |
| `Graph.CreateRelationships` | request (`relationshipsJson`) | **High** on dense graphs | Phase A |
| `Graph.RunCypher` | **response** (`rowsJson`) | **High** — see below | **Phase E (new)** |
| `Graph.QueryNodes` | **response** (`nodes`) | Medium — unbounded if used | **Phase E (new)** |
| `Graph.QueryRelationships` | **response** (`relationships`) | Medium — returns ALL of a type, no limit | **Phase E (new)** |
| `Graph.RunCypher` / `RunCypherWrite` | request (`paramsJson`) | Low — params are small today; unbounded in principle | Phase B + D |
| `Graph.CreateNode` / `CreateRelationship` | request | Low — single row | n/a |
| `Vector.IndexSymbol` | request | Low — single embedding (~14–20 KB) | n/a |
| `Vector.SemanticSearch` | response (`results`) | Low — bounded by `limit` | n/a |
| `Vector.CreateTables` / `DeleteAll`, `Graph.Delete*`, `Health.Check`, `Admin.GetMetrics`/`Shutdown` | both | None — tiny | n/a |

**The live response-direction risk is `RunCypher`.** App read code goes through `runCypher`
(no app callers use `QueryNodes`/`QueryRelationships`), and
`export-render/graph-reader.ts:fetchAllGraphData` issues **unbounded** full-graph reads —
`MATCH (s:`prefix`Symbol`) RETURN … s.signature, s.documentation` and per-type
`MATCH ()-[r]->()` — with **no `LIMIT`/`SKIP`** (`graph-reader.ts:93–202`, 0 pagination).
On a large repo the symbol response alone (signatures + docs) exceeds 4 MB, so
`exportGraph` fails with the same `RESOURCE_EXHAUSTED` in the server→client direction.
This is rejected first by the server's `max_send_message_length` (also 4 MB), so both the
server send limit and the client receive limit must be raised (Phase B) **and** the read
itself must be bounded (Phase E) — a raised limit alone cannot bound an arbitrarily large
graph.

`QueryNodes`/`QueryRelationships` have no current app-logic callers but expose the same
unbounded-response shape through the public adapter API; harden or document them so a
future caller does not reintroduce the failure.

## Improvement Plan

### Phase A: Byte-aware batch chunking (primary fix)

Replace pure row-count chunking with **size-bounded** chunking so no single batch RPC
exceeds a safe wire budget, independent of per-row size.

- Add a `chunkByBudget(items, { maxBytes, maxCount, sizeOf })` helper (alongside the
  existing `chunk` in `persistence-helpers.ts`): accumulate items into a chunk until the
  next item would exceed `maxBytes` *or* `maxCount`, then start a new chunk.
- `sizeOf(item)` = serialized-size estimate. Use a cheap, deterministic estimator — e.g.
  `JSON.stringify(item).length` (UTF-16 length is a safe over-estimate of UTF-8 bytes for
  ASCII-ish payloads; for safety treat it as a byte upper bound or multiply by a small
  factor). Avoid re-serializing twice in the hot path where practical (estimate once,
  reuse).
- Derive `maxBytes` from a budget **well under** the transport limit to leave room for
  protobuf framing + the rest of the message: e.g. `RPC_PAYLOAD_BUDGET_BYTES` defaulting
  to ~3 MB when the wire limit is 4 MB (≈75 %). Centralize in `limits.ts` and make it
  configurable.
- Keep `maxCount` (the current `DB_WRITE_BATCH_SIZE`) as a secondary cap so tiny rows
  still batch reasonably.
- **Single oversized row:** if one item alone exceeds `maxBytes`, emit it as its own
  chunk (cannot split a row) and rely on Phase B's raised ceiling to accept it; log a
  warning so pathological rows (huge `documentation`, very high-dimensional embeddings)
  are visible.

Apply byte-aware chunking on the batch paths for nodes, relationships, and vector
entries in `persistence-helpers.ts`. Embedded-mode batch SQL (`UNWIND`) does not need the
byte budget for the wire, but a `maxCount` cap there is still healthy for statement size.

### Phase B: Raise and align the gRPC message limits (defense in depth + large responses)

Byte-aware chunking bounds *writes*, but the 4 MB cap also breaks large *read responses*
and leaves no headroom for a single large row. Raise and make the limit configurable on
**both** ends so they agree.

- Introduce a configurable `GRPC_MAX_MESSAGE_BYTES` (config + `limits.ts`), default to a
  higher sane value (e.g. 64 MB) — large enough to never reject a legitimately large
  single row or query response, small enough to bound memory.
- Server: use it for `grpc.max_receive_message_length` and
  `grpc.max_send_message_length` (`server.ts:37–40`).
- Client: pass `{ "grpc.max_receive_message_length": N, "grpc.max_send_message_length": N }`
  as the options arg when constructing `Graph`/`Vector` clients
  (`remote-grpc.ts:32–33`) and in `autostart-runtime.ts:157` if it builds clients there.
- Keep Phase A's payload budget **derived from** this limit (budget = limit × ~0.75) so
  raising the limit automatically loosens the chunker, and the two never drift.

Note: raising the limit alone is **not** sufficient — without Phase A a big enough repo
will always find a chunk that exceeds any fixed ceiling. Phase A is the real fix; Phase B
provides headroom and fixes the symmetric read-path limit.

### Phase C: Per-entity batch budgets

Embeddings, nodes, and relationships have very different per-row sizes. Rather than one
`DB_WRITE_BATCH_SIZE`, give each path its own `maxCount` (e.g. relationships can stay
large; embeddings/nodes get a smaller default) while all share the byte budget from
Phase A. This keeps batches efficient without relying on the byte cap to do all the work.

### Phase D: Adaptive split-on-RESOURCE_EXHAUSTED (resilience backstop)

As a safety net for mis-estimation, wrap batch RPC calls so that on a
`RESOURCE_EXHAUSTED` status the helper **splits the failing chunk in half and retries**
each half (recursively, down to a single item). This guarantees forward progress even if
the size estimate is wrong, and surfaces a clear error only when a single indivisible row
truly exceeds the (raised) limit.

- Scope this to the remote batch path; detect the gRPC status code, not a string match.
- Bound recursion and log each split so runaway splitting is visible.

### Phase E: Bound large read responses (server→client direction)

Write chunking (Phase A) does nothing for *responses*. The server builds the entire
result array in memory and sends it as one message, so a large read fails on the server
`max_send` / client `max_receive` cap and also pressures server memory.

- **Paginate `fetchAllGraphData`** (`export-render/graph-reader.ts`): replace each
  unbounded `MATCH … RETURN …` with keyset/`SKIP`+`LIMIT` paging (page size derived from
  the same payload budget as Phase A), accumulating pages client-side. Apply to the
  symbol, relationship (per type), depends-on, membership, and step scans — the symbol and
  relationship scans are the ones that realistically exceed 4 MB.
- **Bound the generic read RPCs**: for `RunCypher`/`QueryNodes`/`QueryRelationships`,
  either (a) document that callers must page large result sets and provide a paging helper,
  or (b) add server-side response chunking/streaming. Prefer caller-side paging for now
  (smaller change, no protocol churn); note streaming as a future option if single-query
  results legitimately need to be huge.
- Keep Phase B's raised limit as headroom so a single large *row* in a page still fits.
- Guard `QueryNodes`/`QueryRelationships` (currently caller-less) with a documented
  max-result expectation so they cannot silently reintroduce the failure.

Acceptance criteria:

- `exportGraph` / `fetchAllGraphData` completes on a graph whose full serialization
  exceeds 4 MB, against a connection server;
- no single read response exceeds the configured budget;
- paging preserves the complete, correctly-ordered result set (no dropped/duplicated rows).

### Phase F: Tests

- Unit: `chunkByBudget` respects `maxBytes` and `maxCount`, never drops/duplicates items,
  emits a lone oversized item as its own chunk, handles empty input.
- Unit: remote adapters never emit a `*_json` payload exceeding the budget for a realistic
  embedding/node fixture (assert serialized size ≤ budget for each produced RPC).
- Server/client: limits are read from config and applied on both ends; a message between
  the old 4 MB and the new limit succeeds end-to-end.
- Adaptive split: a chunk that the (mock) server rejects with `RESOURCE_EXHAUSTED` is
  split and ultimately succeeds; an indivisible oversized row fails with a clear message.
- Regression: an indexing run that previously produced a ~10 MB batch now completes (use
  a fixture sized to exceed 4 MB pre-fix).

## Acceptance Criteria

- Indexing a repo whose batched writes previously exceeded 4 MB completes against a
  connection server with no `RESOURCE_EXHAUSTED`.
- No single batch RPC payload exceeds the configured budget (verified by test).
- Server and client message limits come from one configurable source and agree.
- Large query responses (reads) no longer fail at 4 MB on the client, AND the live
  full-graph read (`fetchAllGraphData`/`exportGraph`) is paged so it cannot exceed the
  budget regardless of graph size (Phase E).
- Embedded-mode indexing behavior is unchanged.
- A single legitimately-large row is accepted (within the raised limit) rather than
  silently dropped; a row exceeding even the raised limit fails loudly.

## Risk Notes

- Raising message limits raises peak memory per in-flight message; keep the default
  bounded (e.g. 64 MB, not unlimited) and consider it alongside the scheduler's
  concurrency so N concurrent large messages don't OOM the server.
- `JSON.stringify(item).length` is an estimate, not exact UTF-8 byte length; keep the
  budget comfortably below the wire limit (the ~0.75 factor) and rely on Phase D for the
  rare miss.
- Smaller embedding batches mean more RPC round trips; the byte budget already balances
  this — do not also shrink `maxCount` so far that throughput regresses.
- Server and client limits must be changed **together**; a client that sends larger than
  the server accepts just relocates the failure. Driving both from one config value
  prevents drift.

## Suggested PR Sequence

1. **Phase A + B** — byte-aware `chunkByBudget` in the batch helpers + configurable,
   aligned, raised gRPC limits on server and client. This pair eliminates the *write*
   error (the reported one).
2. **Phase E** — paginate `fetchAllGraphData` and bound the read RPCs. This eliminates the
   symmetric *read* error (`exportGraph` on a large graph); do it right after A+B since it
   is the same root cause in the other direction.
3. **Phase C** — per-entity `maxCount` defaults.
4. **Phase D** — adaptive split-on-`RESOURCE_EXHAUSTED` backstop (covers both write
   batches and any residual oversized request).
5. **Phase F** lands with each phase (tests are per-phase, not a trailing step).

## First Recommendation

Ship Phase A + B together, then Phase E. A + B fix the reported *write*-direction error
(byte-aware chunking is the correctness fix; the aligned, raised, configurable limit gives
headroom and keeps the two endpoints in sync). Phase E fixes the symmetric *read*-direction
failure the audit surfaced — `fetchAllGraphData`/`exportGraph` reads the whole graph
unbounded and will throw the identical `RESOURCE_EXHAUSTED` on a large repo regardless of
the write fix. Phases C–D are throughput tuning and resilience on top.
