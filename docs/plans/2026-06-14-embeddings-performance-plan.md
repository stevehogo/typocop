# Indexing-Time Embedding Performance Plan

Date: 2026-06-14
Last reconciled with working tree: 2026-06-14

Complements (and redirects) `docs/plans/2026-06-14-ladybugdb-indexing-performance-plan.md`.
That plan optimizes the **persistence** path (batch caps, gRPC payload budget,
write volume). The measured baseline below shows persistence is **only ~2.4%**
of indexing wall-clock. The real cost is **embedding generation (~97%)**. This
plan targets that. The LadybugDB persistence plan is still correct and worth
finishing — it just isn't where the slowness lives.

## Measured Outcomes (2026-06-14 — IMPLEMENTED & TESTED)

Phases 1 and 4 were implemented and measured on a real verbose index of this
repo's `./src` (253 files, ~1250 embeddings, CPU/WSL2, default model
`mxbai-embed-large-v1`). Results overturned the plan's primary hypothesis:

- **Phase 1 (batched `embedTexts`) is a REGRESSION on CPU and is now OPT-IN
  (default OFF).** Controlled A/B on the same binary: per-item `search` 135s vs
  batched 203s — batching is **~50% slower**. Cause confirmed: batched
  cls-pooling pads every text to the longest in the batch, so variable-length
  code symbols waste compute (compounded by `EMBEDDING_CONCURRENCY` parallel
  batches oversubscribing the CPU). The `embedTexts` infra is verified-correct
  (spike 1a: batched == per-item, cosine 1.0, maxAbsDiff 0) and retained behind
  the opt-in `EMBEDDING_ENABLE_BATCH` env flag for GPU / uniform-length corpora.
- **Phase 4 (q8 quantization) is the real win and is now the DEFAULT.** `HF_DTYPE`
  default flipped `fp32 → q8`: `search` 163s → 75s, **total 189s → 99s (~1.9×)**.
  Quality check (20-text near-tie set): mean cosine(fp32, q8) = 0.991 (min 0.988),
  top-1 nearest-neighbour agreement 17/20 (85%). Accepted tradeoff for ~2× speed.
  **Breaking change:** index-time and query-time dtype must match — existing
  fp32-indexed databases should be reindexed. Override with `HF_DTYPE=fp32`.

Net: the lever was precision (q8), not batching. Remaining phases (2 dedup, 3
incremental reuse, 5 thread tuning) are still open and now stack on a ~99s base.

## Scope

Make INDEXING-TIME embedding generation dramatically faster without regressing
output correctness. In scope:

- the embedding port and its adapters
  (`src/infrastructure/embeddings/*`, `src/core/ports/persistence.ts`),
- the two embedding-bound phases of the pipeline — Phase 4 clustering
  (`src/application/indexing/clustering/*`) and Phase 6 search
  (`src/application/indexing/search/*`),
- the bounded-concurrency / timeout machinery in
  `src/platform/utils/limits.ts` and `src/platform/utils/async-pool.ts`,
- embedding model/precision config (`src/platform/config/types.ts`).

Out of scope (covered elsewhere or low ROL): persistence batching, gRPC payload
sizing, query-time embedding latency optimization (warm pools), and any change
that alters query-time embedding *semantics*.

### Query-time embedding alignment (read before Phase 4)

Query-time embedding is out of scope for *latency* optimization but **not** for
*semantic alignment*. Query embedding uses the identical `embedText` path
(`smart-search.ts`, `mcp-server/smart-search-tool.ts`) and must match the
indexing model/dtype config exactly. Any Phase 4 model/dtype default change is a
**breaking schema change**: a user running the old model/dtype at query time
against an index built with a new model/dtype gets silently incorrect cosine
scores. Therefore every Phase 4 spike MUST measure BOTH indexing and query
embeddings, and any default flip MUST land with parallel indexing+query config
alignment and a reindex. The additive batch path (`embedTexts`) does not touch
`embedText`, so Phases 1–3/5 do not affect query semantics.

## Measured Baseline (do not re-measure; build on this)

Real verbose index of this repo's `./src`, captured 2026-06-14 via
`node dist/apps/cli/main.js parse -p ./src -l typescript -v`:

```
total:        191941.3 ms
structure:    19.6 ms
parsing:      1545.6 ms
resolution:   36.5 ms
clustering:   52266.7 ms   <-- 27%  (embedding-bound: semantic classification)
processes:    67.9 ms
search:       133416.9 ms  <-- 70%  (embedding generation: 1241 embeds, 0 failed)
persist:      4585.2 ms    <-- 2.4% (NOT the bottleneck)
corpus: 253 files, 1084 symbols, 2367 relationships, 157 clusters, 184 processes, 1241 embeddings
persist batches: 8 node, 12 rel, 7 vector (0 splits, 0 oversized)
```

Per-embed average ≈ 133417 ms / 1241 ≈ **107 ms/embed** in Phase 6 alone. Phase
4 adds 5 category-reference embeds plus one embed per enriched cluster on top.

Default model is the heaviest/slowest configuration: `mixedbread-ai/mxbai-embed-large-v1`
(335M params, 1024-dim), `dtype: "fp32"`, `pooling: "cls"`, run **one text per
forward pass** (`huggingface-embedding-adapter.ts:66`).

## Bottleneck Analysis (verified against code)

1. **One text per forward pass.** `embedText(text)` calls `ext(text, {pooling})`
   with a single string (`huggingface-embedding-adapter.ts:66`); Ollama posts a
   single `prompt` (`ollama-embedding-adapter.ts:49`). The port
   (`persistence.ts:162-166`) has **no batch method**. Each of 1241 + Phase 4
   embeds pays full per-call fixed overhead.

2. **Two embedding passes, no reuse.** Phase 4 (`enrichment.ts:194-201` →
   `semantic-classifier.ts:131-174`) embeds 5 category references once, then one
   `buildClusterText` per cluster. Phase 6 (`search/index.ts:90-129`) embeds all
   1084 symbols **plus all 157 clusters again** via `formatClusterForEmbedding`.
   The two cluster texts **differ** (`buildClusterText` = names/kinds/signatures;
   `formatClusterForEmbedding` = name + category + confidence + symbol details +
   tags), and the code explicitly flags cross-boundary reuse as unsound
   (`enrichment.ts:163-167`). So today there is genuine duplicated *work*, but a
   naive shared-embedding cache is **unsound**.

3. **Conservative concurrency, fp32, no thread tuning.** `EMBEDDING_CONCURRENCY=3`
   (`limits.ts:52`); pipeline is created with only `{ dtype }`
   (`huggingface-embedding-adapter.ts:113`) — no ONNX intra-op thread config.
   fp32 is the slowest precision on CPU.

4. **No incremental reuse on reindex.** `LadybugVectorAdapter` exposes only
   `indexSymbol` / `indexSymbols` / `semanticSearch` / `deleteAll` — **no
   read-back-by-id path** (verified: grep shows no `queryEmbeddingsBySymbolIds`).
   `--refresh` calls `deleteAll()` and re-embeds everything from scratch.

## Hard constraints (any phase must preserve these)

- **Deterministic output order.** `buildSearchIndex` builds jobs in fixed order
  (all symbols, then all clusters) and `mapWithConcurrency` writes results back
  by input index (`async-pool.ts`). Batching must reassemble in original input
  order. Note: batched vs single-text float results can differ negligibly
  (padding/reduction order) — value-exact embedding assertions in tests may need
  a tolerance.
- **Keyword-only fallback.** Keyword indexing always runs; any item that yields
  no embedding (null/timeout/error) degrades to keyword-only and the pipeline
  never rejects (`search/index.ts:131-160`).
- **Per-item failure accounting.** `EmbeddingStats {attempts, successes,
  failures}` must stay correct **per item**, not per batch.
- **Timeout semantics must be rethought for batches.** Today `withTimeoutOr(...,
  EMBEDDING_TIMEOUT_MS=30000, null)` wraps each single embed. A batch of N texts
  cannot share one 30s budget and still report per-item failures honestly — see
  Phase 1 design notes.
- **Privacy checks stay on the same path.** `verifyEmbeddingText` runs inside
  `formatSymbolForEmbedding` / `formatClusterForEmbedding` / `buildClusterText`
  at job-build time, before any inference. Batching must not move text past the
  privacy gate.
- **`dispose()` must still release the ONNX session**
  (`huggingface-embedding-adapter.ts:88-96`). Any added session options must not
  break disposal.
- **Query-time embedding correctness must not change** (see Regression Safety).
- **Read-back capability required for Phase 3.**
  `VectorAdapter.queryEmbeddingsBySymbolIds(ids: string[])` does **not** exist
  today (verified: grep of `persistence.ts` + `ladybug-vector-adapter.ts` shows
  only `indexSymbol` / `indexSymbols` / `semanticSearch` / `deleteAll`). It must
  be added to the port and implemented in `LadybugVectorAdapter` before any
  Phase 3 reuse logic can be validated or measured. Phase 3 is split into 3a
  (add read-back) and 3b (implement reuse) accordingly; 3a may run in parallel
  with Phase 1.

### Version pins (so spikes target the right code)

- `@huggingface/transformers`: **`^4.2.0`** (pinned in `package.json:54`). All
  transformers.js API spikes below must run against the actually-resolved
  version (`pnpm why @huggingface/transformers` or check `pnpm-lock.yaml`), not
  a docs assumption.
- Ollama: **no version is pinned anywhere in this repo** (no docker-compose, no
  config doc records one). The adapter calls the legacy
  `POST /api/embeddings` with a singular `prompt` (`ollama-embedding-adapter.ts:46-49`).
  Batch support requires the newer `POST /api/embed` with an `input` array,
  which is version-dependent. Because no version is pinned, Ollama batching is
  treated as OPTIONAL/deferred for Phase 1 (see Phase 1 below).

## Improvement Plan (ordered by impact-per-effort)

### Phase 1: Batched embedding via `embedTexts()` on the port + adapters — HIGHEST IMPACT (conditional)

The intended single biggest lever: feed an array of texts to the
feature-extraction pipeline so per-item fixed overhead is amortized across one
forward pass. **This is the highest-leverage phase IF the transformers.js
pipeline accepts array inputs natively AND the measured speedup is ≥2×.** If the
API does not support array inputs, "batching" degenerates to a manual loop with
no inference-time win, and Phase 1 still delivers determinism, an additive port
method, and per-item error handling — but NOT the speedup. Set expectations
accordingly and gate the whole phase on the spike below.

#### MANDATORY SPIKE 1a — array-input API shape (BLOCKS all Phase 1 code)

The current adapter calls `ext(text, { pooling })` with a **single string**
(`huggingface-embedding-adapter.ts:66`) and reads `output.tolist()[0]`. The
array-input signature is **unverified**. Before writing any Phase 1 code, write
a throwaway script that calls the resolved `@huggingface/transformers ^4.2.0`
pipeline with an array, e.g.:

```ts
const ext = await pipeline("feature-extraction", model, { dtype: "fp32" });
const out = await ext(["text one", "text two"], { pooling: "cls" });
console.log(out.dims, out.tolist().length);   // expect [2, 1024] / length 2
```

Record in the spike report:
1. Does `ext(arrayOfTexts, { pooling })` accept an array and return one row per
   input (shape `[N, dim]`)? Document the **exact** signature and output shape.
2. **Per-item error semantics.** Does the call return per-item success/failure,
   or does it return all N outputs or throw on first error? (Strongly expected:
   all-or-nothing — a single malformed/OOM input rejects the whole batch.
   transformers.js has no per-item error channel.) This answer determines the
   timeout/failure design below.
3. **Numerical drift.** Embed the same 20 texts singly vs. in one batch; report
   per-pair cosine similarity and `max(abs(single − batched))` in float space.
   Pooling that uses the attention mask per sentence should keep cosine ≈ 1.0;
   padding/reduction order can still introduce small drift.

If 1a shows arrays are NOT supported, STOP and re-scope Phase 1 to "additive
port method + determinism + per-item accounting" only, and re-prioritize Phase 4
(dtype/model) as the primary speed lever.

#### Batch pooling correctness footnote

The claim "transformers.js applies cls/mean pooling per-sentence using the
attention mask" was previously stated as fact from web research; it is **not
pinned to a source here and must be confirmed by spike 1a step 3** (cosine ≈ 1.0
on the 20-text fixture). Do NOT switch to manual pooling. If a source is found
during the spike, cite the exact `@huggingface/transformers` file/line or GitHub
issue in the spike report.

Changes (all gated on spike 1a passing):

- **Port** (`src/core/ports/persistence.ts`): add an OPTIONAL batch method to
  `EmbeddingAdapter`:
  `embedTexts?(texts: string[]): Promise<(Embedding | null)[]>` — one result per
  input, index-aligned, `null` for any per-item failure. Keep `embedText` as the
  fallback so custom adapters and NoOp need no change.
- **HuggingFace** (`huggingface-embedding-adapter.ts`): implement `embedTexts`
  calling `ext(texts, { pooling })` (signature confirmed by spike 1a);
  `output.tolist()` yields `number[][]` (current single-text code reads
  `vectors[0]`), so a batch reads all rows. **Pre-batch per-item validation:**
  run `verifyEmbeddingText` per text (privacy) AND basic length/encoding checks
  before inference; exclude any failing item up front and mark it `null` in the
  result (do NOT send it into the batch). Validate each returned row's
  dimensions; a bad row → `null` for that index. **Honesty note:** because the
  batch call itself is all-or-nothing (per spike 1a step 2), the adapter
  CANNOT report per-item null from a single failed inference — if `ext()`
  throws/times out after validation, the whole batch fails and the caller falls
  back per-item (see timeout redesign). The "single bad item → null without
  failing the rest" guarantee therefore applies to **pre-inference validation
  failures**, not to inference-time errors.
- **Ollama** (`ollama-embedding-adapter.ts`): **DEFERRED for Phase 1.** No
  Ollama version is pinned in this repo and the adapter uses the legacy
  `/api/embeddings` (singular `prompt`). Phase 1 ships with **HuggingFace +
  NoOp** batch support only; Ollama keeps the per-item `embedText` path (always
  safe — the caller falls back automatically when `embedTexts` is absent).
  Ollama batching is a follow-up: spike the `/api/embed` `input`-array endpoint
  against whatever server version is in use, add feature detection (embed a
  1-item array, check response shape on first init; if unexpected, leave
  `embedTexts` undefined and log a warning), then enable.
- **NoOp**: no change (always returns null; callers fall back).
- **Caller — `buildSearchIndex`** (`search/index.ts`): when the adapter exposes
  `embedTexts`, group jobs into fixed-size batches and feed **batches** through
  `mapWithConcurrency` at the same `EMBEDDING_CONCURRENCY`. Scatter each batch's
  results back to original job indices. Preserve symbols-then-clusters ordering.
  Batch size is tunable via `EMBEDDING_BATCH_SIZE` in `limits.ts` (**default
  16**, conservative; must be ≥1). Callers indexing very large repos or on tight
  memory should lower it; very large texts can OOM at 32. Auto-tuning by
  available memory is possible future work (low priority); the static default is
  intentionally cautious.
- **Caller — semantic classifier** (`semantic-classifier.ts`): batch the 5
  category-reference embeds in `initialize()` into one call. (Per-cluster
  `classify()` batching is addressed by Phase 2.)
- **Timeout / batch-failure redesign** (`limits.ts`, `search/index.ts`):
  the per-item 30s `withTimeoutOr` wrapper cannot wrap a batch and still report
  per-item failures honestly. **Chosen policy: option (b) — fall back to
  per-item `embedText` on batch failure.** Concrete control flow:

  1. Wrap each batch call in a per-batch timeout =
     `min(EMBEDDING_TIMEOUT_MS × batch.length, EMBEDDING_BATCH_TIMEOUT_CAP_MS)`
     (cap default 120000 ms ≈ a 16–32-text batch). Do NOT amortize per item.
  2. **Happy path:** batch resolves → scatter N results to their indices; count
     each item in `EmbeddingStats` individually (success or per-row-null).
  3. **Timeout/throw path:** the whole batch is suspect (all-or-nothing API). Run
     the batch's texts through the existing per-item `embedText` + per-item
     `withTimeoutOr(EMBEDDING_TIMEOUT_MS)` path **exactly once** (no recursion,
     no re-batching). Each item is then counted individually — preserving the
     pre-batching per-item accounting. This bounds retries to one serial pass
     per failed batch, so a hanging adapter cannot cause unbounded retries
     (worst case: every batch fails once and falls back serially, i.e. the
     pre-batch behavior plus one wasted batch attempt).
  4. Document this policy inline in `search/index.ts`.

  This is the only place per-item accounting is recovered; it is mandatory, not
  optional. (Rejected option (a) "mark all items failed on batch timeout" would
  lose per-item accounting and silently keyword-degrade an entire batch.)

Files: `persistence.ts`, `huggingface-embedding-adapter.ts`,
`ollama-embedding-adapter.ts` (deferred — no batch yet),
`noop-embedding-adapter.ts`, `search/index.ts` (`buildSearchIndex` batching +
adapter `embedFn`/`embedTexts` wiring; the actual caller),
`semantic-classifier.ts`, `limits.ts`. (`pipeline.ts` only wires the adapter
into the pipeline; it is not the batching caller.)

Acceptance criteria:

- `embedTexts([a,b,c])` returns 3 index-aligned results. A text that fails
  **pre-inference validation** (privacy/length) is `null` at its index without
  blocking the others. (Inference-time failures are all-or-nothing and handled
  by the per-item fallback, not by per-row nulls — see timeout redesign.)
- A deliberately-broken batch (forced timeout) falls back to per-item
  `embedText`, and `EmbeddingStats` reports each item individually (not as one
  batch-count). A test fixture asserts per-item failure counts match the
  pre-batching behavior exactly.
- `buildSearchIndex` output order is identical to the pre-batch order for a
  fixed input (determinism test; embedding values compared with tolerance —
  see Regression Safety for the exact tolerance).
- Keyword-only fallback and `EmbeddingStats` per-item counts unchanged for a
  fixture with deliberately-failing items.
- Adapters without `embedTexts` (NoOp / Ollama / hypothetical custom) still
  work via the `embedText` fallback path.
- `dispose()` still releases the session after a batched run.

Measure: re-run `node dist/apps/cli/main.js parse -p ./src -l typescript -v`;
compare `search` and `clustering` ms against baseline. **Hypothesis only:** we
estimate a 2–5× `search` reduction (≈21–54 ms/embed vs. the baseline 107
ms/embed) based on published CPU-encoder benchmarks, but actual speedup on this
repo depends on batch size, padding/tokenization overhead amortization, and
model overhead, and is **unknown until re-measured**. Do not treat the range as
a commitment. **Metrics caveat:** baseline metrics count persisted ROWS, not
batch calls / retries / adaptive splits — a high-retry or high-split run is
invisible in current metrics until the persistence plan's Phase B (batch-level
metrics) lands. Flag this as a known measurement gap when interpreting Phase 1
results; do not infer "no retries happened" from unchanged row counts.

### Phase 2: Eliminate duplicated cluster embedding between Phase 4 and Phase 6

Phase 4 and Phase 6 both embed every cluster. Because the two texts differ,
reusing the *embedding* is unsound — so the win is to **avoid embedding the
cluster twice for the same purpose**, not to alias one vector for two texts.

Two viable sub-options (pick after measuring Phase 1):

- **2a (low risk, recommended): unify the cluster text once.** Make Phase 4
  classification consume the **same** `formatClusterForEmbedding` text that Phase
  6 already needs, embed it once, classify from that single vector, and reuse it
  as the Phase 6 cluster embedding. Note the two texts are **substantially
  different**: `buildClusterText(symbols)` is name/kind/signature only
  (`semantic-classifier.ts`), while `formatClusterForEmbedding(cluster, symbols)`
  adds cluster name, category, confidence, and semantic tags (`search/format.ts`).
  So this is a real classification-input change, not a free alias.

  **MANDATORY SPIKE 2a with quantitative acceptance criteria.** Re-classify all
  157 clusters using `formatClusterForEmbedding` text and compare category
  assignments against the current `buildClusterText` output:
  - **Accept 2a only if category agreement ≥ 95% by cluster count** (i.e. < 5%
    drift), or a human reviewer explicitly approves the drift.
  - The spike report MUST include: agreement count (X/157), a list of clusters
    that changed category with old→new labels, and a short why-it-changed
    analysis (e.g. confidence/tags pulled the vector across `SEMANTIC_THRESHOLD=0.50`).
  - **Decision rule:** if agreement < 95% and not approved → **abandon 2a, ship
    2b instead.** A failed 2a spike is NOT a project blocker; 2b is the fallback.
  - Methodology: add a one-off script or extend `semantic-classifier.test.ts` to
    run both text paths over the 157 clusters and emit the agreement stats.
  - Confirm the unified text is privacy-safe (`verifyEmbeddingText` already runs
    inside `formatClusterForEmbedding`).
- **2b (cheapest, already wired): gate Phase 4 semantic classification.** The
  `semanticClassification` opt-out already exists (`pipeline.ts`,
  `enrichment.ts:174-208`); when false, Phase 4 uses the keyword classifier and
  embeds nothing. This removes the full ~52s clustering embedding cost but
  regresses category accuracy from embedding-based to keyword-based. **Measure
  the loss:** run the keyword classifier on the same 157 clusters using only
  name/kind/signature and report per-category precision/recall vs. the semantic
  baseline; document the trade-off in the release notes. Expose 2b via
  CLI/config. Do NOT flip the default: after Phase 1 batching, per-embed cost is
  low, so gating loses category accuracy for minimal savings. **Reconsider the
  default only after Phase 1/2a metrics confirm cluster embedding is no longer a
  dominant cost** — 2b is primarily the fallback for a failed 2a spike, not a
  standalone default change.

Files: `enrichment.ts`, `semantic-classifier.ts`, `search/index.ts`,
`pipeline.ts`, `search/format.ts`, plus CLI/config plumbing for 2b.

Acceptance criteria:

- 2a: each cluster is embedded exactly once during indexing; category
  assignments match the pre-change output within the spike's agreed drift bound;
  Phase 6 cluster embeddings are unchanged in dimensionality and ordering.
- 2b: `--semantic-classification false` (or config) skips all Phase 4 embeds;
  default behavior unchanged; keyword fallback path covered by tests.
- Privacy: no source code in any embedded text (existing `verifyEmbeddingText`
  invariant holds on whichever text path is used).

Measure: re-run verbose index; `clustering` ms should drop sharply (toward
parse-level for 2b; for 2a it folds the cluster embeds into Phase 6's batched
run). Compare `clustering + search` combined against Phase 1.

### Phase 3: Incremental re-embedding on reindex (content-hash + persisted-vector reuse)

First full index gets no benefit; reindexes of a mostly-stable repo do. Requires
a **read-back path that does not exist today** (see Hard constraints). Split:

**Phase 3a (small, may run in parallel with Phase 1): add read-back.**
Add `VectorAdapter.queryEmbeddingsBySymbolIds(ids: string[])` (read
`symbol_id, embedding, dimensions, metadata` from the embeddings table) to the
port (`persistence.ts`) and `LadybugVectorAdapter`. No reuse logic yet. This is
a small port change and a prerequisite for 3b; landing it early avoids blocking
3b on PR-review latency.

**Phase 3b (reuse logic, lands last): content-hash + skip unchanged embeds.**

- Content-hash the **formatted** embed text (SHA-256 of
  `formatSymbolForEmbedding(symbol)` output) and store it in vector metadata.
- **Cache key = `EMBEDDING_FORMAT_VERSION + modelId + dtype + textHash`**, stored
  as `{ formatVersion, modelId, dtype, textHash }` in vector metadata; a
  query-time cache MISS occurs if **any** field differs.
- **`EMBEDDING_FORMAT_VERSION` ownership:** add `export const
  EMBEDDING_FORMAT_VERSION = 1` in `search/format.ts`. It MUST be incremented on
  any change to the output shape of `formatSymbolForEmbedding` or
  `formatClusterForEmbedding`. A test ("bump formatVersion → reindex same symbols
  → vectors replaced, not reused") guards against forgotten bumps.
- **Interaction with Phase 1 batch drift (must resolve in spike 1a first).**
  Reuse compares by hash, then serves the stored vector verbatim — it never
  re-embeds, so it cannot itself introduce drift. BUT: a symbol embedded in a
  batch on run 1 and (hypothetically) singly on run 2 could differ slightly if
  spike 1a step 3 found batch-vs-single drift > tolerance. Resolution: (i) if
  spike 1a shows drift below tolerance (cosine ≥ 0.9999), reuse is sound as-is;
  (ii) if drift exceeds tolerance, either always embed via the same code path
  (batch) so stored and recomputed vectors are comparable, or include the
  embedding-path in the cache key. **Phase 3b is deferred until Phase 1 is
  complete and its drift measurement is in hand**; re-assess feasibility then.
- Before Phase 6, for symbols present in both old and new index with a matching
  cache key, reuse the persisted vector and skip the embed.
- **Cluster reuse is initially OUT of scope.** Cluster text changes whenever
  membership or confidence changes; on a typical 1-symbol-edit reindex many
  clusters' hashes invalidate. **Spike before building cluster caching:** reindex
  `./src` with one symbol added/removed and count clusters whose text hash
  changed. If > 50% invalidate, ship **symbol-only reuse** in 3b's first release
  and revisit cluster caching after the Phase 1/2/4 cost-benefit is clear.
- Replace the unconditional `deleteAll()` on `--refresh` with a delete-then-reuse
  flow (or an incremental mode flag); preserve `--refresh` full-rebuild as an
  explicit option.

Files: `persistence.ts`, `ladybug-vector-adapter.ts`,
`src/apps/cli/executor.ts`, `search/index.ts`,
`search/format.ts` (export `EMBEDDING_FORMAT_VERSION` + a stable hashable text).

Acceptance criteria:

- 3a: `queryEmbeddingsBySymbolIds` returns stored vectors/metadata for known
  ids and an empty result for unknown ids; covered by adapter tests.
- 3b: a second index of an unchanged repo embeds ~0 symbols and produces a
  search index identical (within drift tolerance) to a from-scratch run.
- Changing one symbol re-embeds only that symbol (and, if cluster caching ships,
  any cluster whose hash changed).
- Bumping `EMBEDDING_FORMAT_VERSION` (or changing model/dtype) invalidates the
  cache (no stale vectors served) — covered by the bump test.
- `--refresh` still forces a full re-embed.

Measure: index `./src`, then index again unchanged; second-run `search` ms
should approach keyword-only timing. Then touch one file and confirm only the
affected embeds run.

### Phase 4: Precision (dtype) and model choice

Stacks multiplicatively with batching. `config.dtype` is already typed
`fp32|fp16|q8` (`config/types.ts:36`) and threaded into the pipeline ctor
(`huggingface-embedding-adapter.ts:113`).

**Reminder:** any model/dtype default flip is a breaking schema change for BOTH
indexing and query-time embedding (see "Query-time embedding alignment"). Every
spike below MUST measure indexing AND query embeddings and confirm they stay on
identical config.

Changes / experiments (**all verify with a spike**, A/B on `./src` — do NOT rely
on web-research averages; they are model- and corpus-specific):

- **q8 (int8) for HuggingFace.** Web research *suggests* ~2–4× CPU speedup with
  ~1–3% retrieval-quality loss, but this is unverified for this model/corpus.
  **MANDATORY q8 SPIKE (do these in order, stop on first failure):**
  1. Verify `mixedbread-ai/mxbai-embed-large-v1` actually publishes a q8/int8
     quantized ONNX variant on Hugging Face. If it does not, q8 is not
     available for the default model — record that and stop.
  2. Test `pipeline("feature-extraction", model, { dtype: "q8" })`; confirm it
     loads and outputs **1024-dim** vectors (the adapter validates dims at
     `huggingface-embedding-adapter.ts:71`).
  3. A/B index `./src` fp32 vs. q8; report `search` + `clustering` ms AND
     quality side by side: cluster category agreement (reuse the Phase 2a ≥ 95%
     bar) plus a small search-recall check. Report speed delta and accuracy cost
     together before changing any default.
  **fp16 is a CPU trap** — little/no speedup without GPU/WebGPU; do not expect
  fp16 to help the measured CPU bottleneck. Keep dtype selectable (do not
  silently force quality loss).
- **Smaller model as an opt-in "fast indexing" profile** (e.g.
  `mxbai-embed-xsmall-v1` 22.7M/384-dim, or `all-MiniLM-L6-v2` / `bge-small-en-v1.5`
  / `gte-small`, all 384-dim). Order-of-magnitude faster per embed; web research
  estimates ~5–8% retrieval-accuracy cost (verify per the q8 A/B method).
  **This is a schema migration**: 1024→384 invalidates persisted vectors and the
  vector index and requires a reindex, AND query-time config must move in
  lockstep. Cannot be a drop-in default.
- **Phase 4b (future, optional): Matryoshka truncation.** mxbai-large reportedly
  supports truncation to fewer dims (e.g. 384) from the same model — **verify
  the model card supports it before assuming.** If supported, spike a variant
  that enables truncation and measure indexing speed + search quality vs. full
  1024-dim. Accept as an optional speedup only if quality holds (< 2% recall
  loss). Still a vector-dimension/schema change requiring reindex. Not required
  for the baseline plan.

Files: `config/types.ts` (defaults / docs), config loader, CLI flags;
optionally a probe of available dtypes with fp32 fallback so a missing dtype
doesn't loop-retry-fail (the adapter resets `initPromise` on init failure —
`:122-126` — so a bad dtype would retry-fail repeatedly).

Acceptance criteria:

- dtype is configurable; **if** the q8 spike confirms a published variant, q8
  produces 1024-dim vectors that pass validation.
- Spike report quantifies speed delta AND quality delta (cluster category
  agreement ≥ 95% + a small search-recall check) for BOTH index and query
  embeddings before changing any default.
- Model swap, if adopted, ships with dimension/schema migration + reindex notes
  AND query-config alignment; default model unchanged unless the spike justifies
  it.

Measure: A/B verbose index per dtype/model; report `search` + `clustering` ms
and the quality deltas side by side.

### Phase 5: Concurrency and ONNX thread tuning (avoid CPU oversubscription)

Smallest lever; do it **last** because it interacts dangerously with Phases 1/4.

Changes (**verify with a spike** — platform-dependent):

- Make `EMBEDDING_CONCURRENCY` provider-aware: local in-process HuggingFace is
  CPU-bound and over-subscribes if both JS concurrency and ONNX intra-op threads
  are high; remote Ollama is latency-bound and tolerates higher JS concurrency.
- **MANDATORY SPIKE — does the thread-tuning lever even exist?** It is
  **unverified** that `@huggingface/transformers ^4.2.0` exposes ONNX intra-op
  thread config via `env.backends.onnx` (or any equivalent), and there is no
  documented `ORT_NUM_THREADS` path through transformers.js. Before writing
  Phase 5 thread code: `import { env } from "@huggingface/transformers"` and
  inspect whether `env.backends.onnx` (and a numeric thread setter) is present
  and mutable in the resolved version + onnxruntime-node. Record the exact API
  signature found.
  - If the knob is **not** exposed: Phase 5 reduces to a **JS-concurrency sweep
    only** (tune `EMBEDDING_CONCURRENCY`); document that intra-op tuning is
    unavailable at this version and mark it future work pending a transformers.js
    update. Do NOT ship non-functional thread code.
  - If exposed (Node binding only — not onnxruntime-web): set it programmatically
    before pipeline init.
- **Tune the two together** (only if the knob exists): `EMBEDDING_CONCURRENCY ×
  intraOpNumThreads` must not exceed physical cores, or cache
  thrashing/context-switching makes it slower. With Phase 1 batching, prefer
  **fewer concurrent JS batches × more intra-op threads per batch** (often
  concurrency 1–2 + high intra-op).
- **Concrete sweep grid (baseline 4-core machine):** sweep
  `EMBEDDING_CONCURRENCY ∈ {1,2,3}` × `intra-op ∈ {1,2,4}` (skip the intra-op
  axis if the knob is unavailable). Measure `search` + `clustering` ms per combo.
  **Stopping rule:** pick the fastest pair that does not OOM; if two are within
  measurement noise, prefer the lower total thread count. Document the chosen
  pair and note it is platform-dependent (re-run the sweep on 8-core if that is
  the target deployment).

Files: `limits.ts`, `huggingface-embedding-adapter.ts` (thread/session config,
only if the knob exists), `pipeline.ts` (provider-aware concurrency selection).

Acceptance criteria:

- No OOM and no regression vs. Phase 1 timings on the baseline machine.
- A documented, measured concurrency × thread setting per provider class (or a
  documented finding that intra-op tuning is unavailable + the chosen
  concurrency-only setting).
- Timeout semantics from Phase 1 unchanged.

Measure: sweep concurrency × intra-op threads (per the grid above) on the
verbose `./src` index; pick the fastest non-OOM combination; record it.

## Suggested PR Sequence

1. **Phase 1** (gated on spike 1a) — `embedTexts` port + HF/NoOp adapters +
   batched `buildSearchIndex` + per-batch timeout/per-item-fallback redesign.
   (Biggest single win IF the array API exists; everything else stacks on it.)
   Ship the array-API + batch-pooling spike (1a) result in the PR description.
   **In parallel: Phase 3a** — add `queryEmbeddingsBySymbolIds` to the port and
   `LadybugVectorAdapter` (small change, no reuse logic), so Phase 3b isn't
   blocked on review latency.
2. **Phase 2a** (or 2b if the 2a unify spike shows ≥ 5% category drift and isn't
   approved) — remove duplicated cluster embedding, folding cluster embeds into
   the Phase 1 batched run.
3. **Phase 4** — dtype/model spike + make q8 selectable (default flip only if the
   spike justifies it, with query-config alignment). Independent of Phase 3.
4. **Phase 5** — concurrency (× ONNX thread, if the knob exists) tuning, measured
   against the post-Phase-1/2/4 baseline.
5. **Phase 3b** — incremental re-embedding reuse logic (most code surface;
   benefits reindex, not first index). Lands after the per-embed cost is already
   low and after Phase 1's batch-drift measurement confirms reuse soundness.

## First Recommendation

Start with **spike 1a, then Phase 1 (batched `embedTexts`)**. Phase 1 attacks the
dominant 70% `search` phase and the 27% `clustering` phase at their root cause
(one forward pass per text) with a single, additive port method that preserves
the keyword-only fallback and per-item accounting via an `embedText` fallback
path. **It is conditional on spike 1a**: write a throwaway script first to
confirm (i) `ext(arrayOfTexts, { pooling })` is supported and returns one row per
input on `@huggingface/transformers ^4.2.0`, (ii) its per-item error semantics
(expected all-or-nothing), and (iii) singly-vs-batched cosine ≈ 1.0 on a 20-text
fixture. If arrays aren't supported natively the speedup is void — re-scope
Phase 1 to determinism + per-item accounting and promote Phase 4 (dtype/model) as
the primary speed lever instead.

## Bottlenecks to re-measure (after each phase)

Re-run the exact baseline command and compare:

- `clustering` ms and `search` ms (the two embedding-bound phases),
- total ms, and the embed count / per-embed average,
- `embeddingAttempts` / `embeddingFailures` (must not grow — failures mean
  silent keyword-only degradation),
- for Phase 3: second-run (unchanged) `search` ms vs. first-run.

`embeddingElapsedMs` attributes the **entire** Phase 6 wall-clock to embeddings
(`pipeline.ts:185-187`), including keyword indexing — treat it as an upper bound,
not true embedding cost (carried from the persistence plan's caveat).

**Determinism / re-measurement stability.** Batched embeddings can differ from
single-text by a tiny amount (padding/accumulation order, typically < 0.1% per
dimension). To avoid flaky regression calls: before re-measuring, confirm the
baseline command produces stable output across 3 runs (or tolerance-check with
cosine ≥ 0.9999 per embedding), and apply that **same tolerance to every
post-phase comparison**. Do not flag a difference within tolerance as a
regression.

**Metrics gap caveat.** Baseline metrics count persisted ROWS, not batch
calls / retries / adaptive splits. A high-retry or high-split run is invisible
until the persistence plan's Phase B (batch-level metrics) lands. Either land
Phase B before trusting fine-grained Phase 1–5 retry counts, or explicitly note
when interpreting results that "unchanged row counts" does not prove "no
batch-fallback retries occurred."

## Regression Safety

- **Known Kùzu teardown flake.** Real-Kùzu integration tests
  (`connection-server.*.integration.test.ts`) intermittently fail on teardown
  ("Timeout terminating forks worker"). This is a pre-existing native-teardown
  issue, not a regression — re-run suspect failures in isolation before blaming
  an embedding change.
- **Query-time embedding must not change.** Query embedding goes through the same
  `embedText` (`smart-search.ts`, `mcp-server/smart-search-tool.ts`). Phases here
  must keep `embedText` behaving identically (the batch path is additive). If
  Phase 4 changes the default model/dtype, query and index embeddings must use
  the **same** config or cosine scores won't align — treat any model/dtype
  default change as affecting both sides and reindex.
- **Determinism tests.** Add/keep a test asserting `buildSearchIndex` output
  **order** is stable across runs. For embedding **values**, allow a float
  tolerance for batched-vs-single numerical drift. **Concrete tolerance:**
  measure cosine similarity between single-text and batched embeddings on the
  20-symbol spike-1a fixture and compute mean/max `abs(single − batched)` in
  float space. Accept tolerance ≥ 1e-5 (padding/reduce rounding); if max drift
  exceeds 1e-3, log a warning and investigate pooling behavior. Update any
  existing exact-value embedding assertions to `expect(actual).toBeCloseTo(expected, 5)`
  (or cosine ≥ 0.9999) rather than strict equality.
- **Privacy.** `verifyEmbeddingText` must remain on every text path before
  inference; batching must not bypass it.
- **Rollback / feature flag.** Keep the per-item `embedText` path always
  available — an adapter without `embedTexts` (or a caller that skips it)
  transparently falls back, so the change is backward compatible. For a fast
  workaround if Phase 1 batching ever introduces a silent correctness
  regression (e.g. padding corruption), add an env flag
  `EMBEDDING_DISABLE_BATCH=true` (read in `config/types.ts` / the config loader)
  that forces all callers to skip `embedTexts` and use per-item `embedText`, so a
  regression can be reverted without recompiling. Document the flag in
  `config/types.ts`.

## Honest uncertainty (verify with a spike, do not ship on faith)

- **Array-input API is UNVERIFIED.** The current adapter only ever calls
  `ext(text, …)` with a single string. Whether `ext(arrayOfTexts, …)` is
  supported on `@huggingface/transformers ^4.2.0` — and whether it reports
  per-item errors or is all-or-nothing — is unknown and is the gating spike 1a.
  Phase 1's speedup is void if arrays aren't supported natively.
- Batched CPU speedup magnitude (2–5×) is a web-research estimate, not a
  commitment; confirm with the re-run, not the claim.
- Batch pooling correctness depends on transformers.js applying the attention
  mask per-sentence — **stated previously as fact from web research but not
  pinned to a source here**; verify on the resolved `^4.2.0` with the cosine
  spike (1a step 3) and cite the source if found.
- **Ollama: no version is pinned in this repo** and the adapter uses the legacy
  singular-`prompt` `/api/embeddings`. Ollama batching (`/api/embed` `input`
  array) is deferred out of Phase 1; spike + feature-detect before enabling;
  per-item fallback is always safe.
- q8 speed/quality and smaller-model quality are model- and corpus-specific —
  A/B on `./src` with category-agreement (≥ 95%) + recall checks before any
  default flip; verify the model actually publishes a q8 variant first.
- **ONNX thread tuning knob (`env.backends.onnx`) is UNVERIFIED** on `^4.2.0`;
  Phase 5 spike must confirm it exists before relying on it, else Phase 5 is a
  JS-concurrency sweep only.
- ONNX thread settings (if available) are platform-dependent and can *slow
  things down* if over-subscribed — sweep, don't assume.
