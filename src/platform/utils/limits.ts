// Resource limits — enforced throughout the system (Req 23)

/** Minimum cosine similarity score for semantic search results (Req 17.3) */
export const SEMANTIC_SEARCH_THRESHOLD = 0.45;

/** Maximum source file size in bytes before skipping during indexing (Req 23.1) */
export const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512 KB — matches two-phase scan threshold

/** Alias used by the parser module */
export const MAX_FILE_SIZE = MAX_FILE_SIZE_BYTES;

/**
 * Minimum tree-sitter buffer size (512 KB).
 * tree-sitter requires bufferSize >= file size in bytes.
 */
export const TREE_SITTER_BUFFER_SIZE = 512 * 1024;

/**
 * Maximum tree-sitter buffer size cap (32 MB) to prevent OOM on huge files.
 * Also used as the file-size skip threshold for very large files.
 */
export const TREE_SITTER_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Compute adaptive buffer size for tree-sitter parsing.
 * Uses 2× file size, clamped between 512 KB and 32 MB.
 */
export const getTreeSitterBufferSize = (contentLength: number): number =>
  Math.min(Math.max(contentLength * 2, TREE_SITTER_BUFFER_SIZE), TREE_SITTER_MAX_BUFFER);

/**
 * Bounded concurrency for Phase 2 parsing (B5).
 *
 * Conservative default (plan recommends 4–8). Each concurrent slot owns its own
 * per-grammar-variant `Parser` instances, so a tree-sitter parser is never
 * shared across in-flight parses. Higher values trade memory (more parser
 * instances) for throughput; keep it modest to avoid starving the event loop
 * during synchronous tree-sitter parses.
 */
export const PARSE_CONCURRENCY = 4;

/**
 * Bounded concurrency for Phase 6 embedding generation (Phase C).
 *
 * Conservative default. Local model backends (Ollama, in-process HuggingFace)
 * can become *slower* under overload, so keep this small (plan recommends 2–4
 * for local backends). The pipeline may pass an adapter-appropriate value for
 * remote/HTTP providers later; this default must stay safe for the slowest
 * (local) case. Used with {@link mapWithConcurrency} so there is never an
 * unbounded `Promise.all` over embeddings.
 */
export const EMBEDDING_CONCURRENCY = 3;

/**
 * Per-embedding timeout in milliseconds (Phase C).
 *
 * Caps a single embedding call so one slow item cannot stall the whole index.
 * On timeout the item is treated as a failure (skipped → keyword-only), not a
 * pipeline rejection. Generous enough for a cold local model to respond.
 */
export const EMBEDDING_TIMEOUT_MS = 30_000;

/**
 * Bounded chunk size for batch database writes (Phase D).
 *
 * When an adapter implements the OPTIONAL batch methods
 * (`GraphAdapter.createNodes` / `createRelationships`,
 * `VectorAdapter.indexSymbols`), the indexing pipeline groups same-label /
 * same-type rows and splits them into chunks of at most this many rows per
 * call. This keeps a single write (one query or one RPC) bounded so very large
 * repos do not build an unbounded statement or payload. The metrics counts
 * (graphNodeWrites/graphEdgeWrites/vectorWrites) still reflect ROWS written,
 * not the number of batch calls.
 */
export const DB_WRITE_BATCH_SIZE = 500;

/**
 * Maximum number of traced entry points for Phase 5 process tracing (Phase F).
 *
 * Process tracing scales with the number of entry points: every entry point
 * seeds a depth-first traversal of the call graph. On very large repos this can
 * produce an excessive number of traces. This cap limits how many entry points
 * (highest-scoring first) are traced.
 *
 * DEFAULT is `Infinity` — i.e. UNLIMITED, preserving current behavior exactly.
 * Wiring exists so a caller (or a future benchmark-driven default) can clamp the
 * count without changing the scoring or ordering of entry points. Do not lower
 * the default without a benchmark demonstrating the need (plan Phase F).
 */
export const MAX_ENTRY_POINTS = Infinity;

/** Maximum number of nodes in the knowledge graph (Req 23.2) */
export const MAX_GRAPH_SIZE_NODES = 500_000;

/** Query execution timeout in milliseconds (Req 23.3) */
export const QUERY_TIMEOUT_MS = 2_000;

/** Maximum graph traversal depth to prevent infinite loops (Req 23.4, 16.7) */
export const MAX_TRAVERSAL_DEPTH = 20;

/** POSIX and common C++ standard library headers treated as internal/system headers. */
export const C_SYSTEM_HEADERS: ReadonlySet<string> = new Set([
  "algorithm", "array", "atomic", "bitset", "cassert", "cctype", "cerrno",
  "cfenv", "cfloat", "charconv", "chrono", "cinttypes", "climits", "clocale",
  "cmath", "codecvt", "compare", "complex", "concepts", "condition_variable",
  "coroutine", "csetjmp", "csignal", "cstdarg", "cstddef", "cstdint",
  "cstdio", "cstdlib", "cstring", "ctgmath", "ctime", "cuchar", "cwchar",
  "cwctype", "deque", "exception", "execution", "expected", "filesystem",
  "format", "forward_list", "fstream", "functional", "future", "initializer_list",
  "iomanip", "ios", "iosfwd", "iostream", "istream", "iterator", "latch",
  "limits", "list", "locale", "map", "memory", "memory_resource", "mutex",
  "new", "numbers", "numeric", "optional", "ostream", "queue", "random",
  "ranges", "ratio", "regex", "scoped_allocator", "semaphore", "set",
  "shared_mutex", "source_location", "span", "sstream", "stack", "stdexcept",
  "stdfloat", "stop_token", "streambuf", "string", "string_view", "strstream",
  "syncstream", "system_error", "thread", "tuple", "type_traits", "typeindex",
  "typeinfo", "unordered_map", "unordered_set", "utility", "valarray", "variant",
  "vector", "version", "cassert", "complex.h", "ctype.h", "errno.h", "fenv.h",
  "float.h", "inttypes.h", "iso646.h", "limits.h", "locale.h", "math.h",
  "setjmp.h", "signal.h", "stdalign.h", "stdarg.h", "stdatomic.h", "stdbool.h",
  "stddef.h", "stdint.h", "stdio.h", "stdlib.h", "stdnoreturn.h", "string.h",
  "tgmath.h", "threads.h", "time.h", "uchar.h", "wchar.h", "wctype.h",
]);

/** Common VCS hosts used to identify Go module import roots. */
export const GO_VCS_HOSTS: ReadonlySet<string> = new Set([
  "bitbucket.org",
  "codeberg.org",
  "git.sr.ht",
  "github.com",
  "gitlab.com",
  "golang.org",
]);

/**
 * Validates if a file size is within the allowed limit.
 * 
 * @param sizeBytes - File size in bytes
 * @returns true if file size is within limit, false otherwise
 */
export function isFileSizeValid(sizeBytes: number): boolean {
  return sizeBytes > 0 && sizeBytes <= MAX_FILE_SIZE_BYTES;
}

/**
 * Validates if a graph size is within the allowed limit.
 * 
 * @param nodeCount - Number of nodes in the graph
 * @returns true if graph size is within limit, false otherwise
 */
export function isGraphSizeValid(nodeCount: number): boolean {
  return nodeCount >= 0 && nodeCount <= MAX_GRAPH_SIZE_NODES;
}

/**
 * Creates a timeout promise that rejects after the specified duration.
 * Used to enforce query timeout limits.
 * 
 * @param timeoutMs - Timeout duration in milliseconds (defaults to QUERY_TIMEOUT_MS)
 * @returns Promise that rejects with a timeout error
 */
export function createQueryTimeout(timeoutMs: number = QUERY_TIMEOUT_MS): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Query execution exceeded timeout of ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

/**
 * Wraps a query execution with a timeout limit.
 * 
 * @param queryFn - The async query function to execute
 * @param timeoutMs - Timeout duration in milliseconds (defaults to QUERY_TIMEOUT_MS)
 * @returns Promise that resolves with query result or rejects on timeout
 * 
 * @example
 * ```typescript
 * const result = await withQueryTimeout(
 *   async () => executeComplexQuery(params),
 *   2000
 * );
 * ```
 */
export async function withQueryTimeout<T>(
  queryFn: () => Promise<T>,
  timeoutMs: number = QUERY_TIMEOUT_MS
): Promise<T> {
  return Promise.race([
    queryFn(),
    createQueryTimeout(timeoutMs)
  ]);
}

/**
 * Run an async operation with a timeout that resolves to a SENTINEL instead of
 * rejecting when it elapses.
 *
 * Unlike {@link withQueryTimeout} (which rejects on timeout), this is the
 * failure-tolerant variant used by embedding generation: a slow item must not
 * reject the surrounding batch. If `fn()` itself rejects, this still rejects —
 * callers that need full tolerance should also catch their own throws (the
 * embedding path does both: catch + this timeout).
 *
 * The timer is always cleared so a slow-but-eventually-resolving operation does
 * not leak a pending timer or keep the event loop alive.
 *
 * @param fn        - The async operation to run.
 * @param timeoutMs - Timeout in milliseconds.
 * @param onTimeout - Value (or factory) returned when the timeout elapses first.
 * @returns The operation's result, or the timeout sentinel if it elapses first.
 */
export async function withTimeoutOr<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  onTimeout: T | (() => T),
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const TIMED_OUT = Symbol("timed-out");
  // Hold the operation promise so we can both race it AND attach a guard handler.
  // If the timeout wins the race and `fn()` LATER rejects, that rejection would
  // otherwise be unhandled (the race already settled), emitting a Node
  // unhandledRejection warning. The guard swallows the late rejection. A
  // rejection that arrives BEFORE the timeout is still observed by the race
  // below, so this preserves the "rejects if fn() rejects" contract.
  const operation = fn();
  void operation.catch(() => {});
  try {
    const result = await Promise.race<T | typeof TIMED_OUT>([
      operation,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
    if (result === TIMED_OUT) {
      return typeof onTimeout === "function" ? (onTimeout as () => T)() : onTimeout;
    }
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Validates if a traversal depth is within the allowed limit.
 * 
 * @param depth - Current traversal depth
 * @returns true if depth is within limit, false otherwise
 */
export function isTraversalDepthValid(depth: number): boolean {
  return depth >= 0 && depth <= MAX_TRAVERSAL_DEPTH;
}
