// Resource limits — enforced throughout the system (Req 23)

/** Maximum source file size in bytes before skipping during indexing (Req 23.1) */
export const MAX_FILE_SIZE_BYTES = 1_000_000; // 1 MB

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
