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

/** Maximum number of nodes in the knowledge graph (Req 23.2) */
export const MAX_GRAPH_SIZE_NODES = 500_000;

/** Query execution timeout in milliseconds (Req 23.3) */
export const QUERY_TIMEOUT_MS = 2_000;

/** Maximum graph traversal depth to prevent infinite loops (Req 23.4, 16.7) */
export const MAX_TRAVERSAL_DEPTH = 20;

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
 * Validates if a traversal depth is within the allowed limit.
 * 
 * @param depth - Current traversal depth
 * @returns true if depth is within limit, false otherwise
 */
export function isTraversalDepthValid(depth: number): boolean {
  return depth >= 0 && depth <= MAX_TRAVERSAL_DEPTH;
}
