/**
 * Privacy and Data Protection Verification
 *
 * This module documents and verifies that all code processing happens locally
 * and that no full source code is sent to external services.
 *
 * Requirements: 22.1, 22.2
 */

/**
 * Privacy Policy Documentation
 *
 * The Code Graph Analyzer follows strict privacy principles:
 *
 * 1. LOCAL-ONLY CODE PROCESSING (Req 22.1)
 *    - All parsing happens locally using tree-sitter
 *    - All indexing phases (1-6) execute locally
 *    - Graph database (Neo4j) runs locally or in user-controlled infrastructure
 *    - Vector store (PostgreSQL + pgvector) runs locally or in user-controlled infrastructure
 *    - No source code is transmitted to external services
 *
 * 2. SYMBOL SIGNATURES ONLY FOR EMBEDDINGS (Req 22.2)
 *    - When using external embedding APIs (OpenAI), only symbol signatures are sent
 *    - Symbol signatures include: name, kind, signature, documentation, visibility, modifiers
 *    - Full source code content is NEVER included in embedding requests
 *    - File paths are NEVER included in embedding requests
 *
 * 3. AI ENRICHMENT (Optional, Req 24.1)
 *    - When AI enrichment is enabled, only symbol names and kinds are sent
 *    - Cluster enrichment sends: heuristic label + list of "name (kind)" pairs
 *    - Maximum 20 symbols per cluster enrichment request
 *    - No source code, file paths, or implementation details are sent
 *
 * 4. QUERY PROCESSING
 *    - Natural language queries are processed locally
 *    - Query results contain only metadata (symbol names, relationships, clusters)
 *    - No source code is included in query responses
 */

/**
 * Data sent to external services (when enabled):
 */
export interface ExternalDataPolicy {
  readonly service: "openai-embeddings" | "ai-enrichment";
  readonly dataTypes: readonly string[];
  readonly excludedData: readonly string[];
  readonly purpose: string;
}

export const EXTERNAL_DATA_POLICIES: readonly ExternalDataPolicy[] = [
  {
    service: "openai-embeddings",
    dataTypes: [
      "symbol name",
      "symbol kind",
      "symbol signature",
      "symbol documentation",
      "symbol visibility",
      "symbol modifiers",
      "cluster name",
      "cluster category",
      "cluster confidence score",
    ],
    excludedData: [
      "full source code",
      "file paths",
      "file content",
      "implementation details",
      "variable values",
      "runtime data",
    ],
    purpose: "Generate semantic embeddings for symbol and cluster search",
  },
  {
    service: "ai-enrichment",
    dataTypes: [
      "heuristic cluster label",
      "symbol names (max 20)",
      "symbol kinds",
    ],
    excludedData: [
      "full source code",
      "file paths",
      "file content",
      "symbol signatures",
      "implementation details",
      "variable values",
      "runtime data",
    ],
    purpose: "Generate descriptive cluster names",
  },
] as const;

/**
/**
 * Verify that a text string does not contain full source code.
 *
 * This is a heuristic check that looks for patterns that indicate source code
 * rather than just metadata.
 *
 * Requirements: 22.2
 */
export function containsSourceCode(text: string): boolean {
  // Check for common source code patterns
  // These patterns look for multi-line code blocks, not just isolated syntax
  const sourceCodePatterns = [
    /function\s+\w+\s*\([^)]*\)\s*\{\s*\n[\s\S]{5,}/,  // function definitions with body
    /class\s+\w+\s*\{\s*\n[\s\S]{5,}/,                  // class definitions with body
    /const\s+\w+\s*=\s*\([^)]*\)\s*=>\s*\{/,            // arrow functions with block
    /if\s*\([^)]+\)\s*\{\s*\n[\s\S]{5,}/,               // if statements with body
    /for\s*\([^)]+\)\s*\{\s*\n[\s\S]{5,}/,              // for loops with body
    /while\s*\([^)]+\)\s*\{\s*\n[\s\S]{5,}/,            // while loops with body
    /import\s+.*\s+from\s+['"`]/,                        // import statements
    /require\s*\(['"`][^'"`]+['"`]\)/,                   // require statements
    /\breturn\s+[^;]+;/,                                 // return statements
    /\bthrow\s+new\s+\w+/,                               // throw statements
  ];

  return sourceCodePatterns.some(pattern => pattern.test(text));
}

/**
 * Verify that embedding text contains only symbol signatures.
 *
 * Throws an error if the text appears to contain full source code.
 *
 * Requirements: 22.2
 */
export function verifyEmbeddingText(text: string, context: string): void {
  if (containsSourceCode(text)) {
    throw new Error(
      `Privacy violation: Embedding text for ${context} appears to contain source code. ` +
      `Only symbol signatures should be sent to external services.`
    );
  }

  // Check for absolute file paths (should not be in embedding text)
  // Allow relative paths in symbol names (e.g., "path/to/module")
  if (/(?:^|[\s:])(?:[A-Z]:[\/\\]|\/[a-z]+\/)/i.test(text)) {
    throw new Error(
      `Privacy violation: Embedding text for ${context} contains file paths. ` +
      `File paths should not be sent to external services.`
    );
  }
}

/**
 * Verify that AI enrichment prompt contains only metadata.
 *
 * Throws an error if the prompt appears to contain source code or file paths.
 *
 * Requirements: 24.1
 */
export function verifyEnrichmentPrompt(prompt: string, context: string): void {
  if (containsSourceCode(prompt)) {
    throw new Error(
      `Privacy violation: AI enrichment prompt for ${context} appears to contain source code. ` +
      `Only symbol names and kinds should be sent to external services.`
    );
  }

  // Check for absolute file paths
  if (/(?:^|[\s:])(?:[A-Z]:[\/\\]|\/[a-z]+\/)/i.test(prompt)) {
    throw new Error(
      `Privacy violation: AI enrichment prompt for ${context} contains file paths. ` +
      `File paths should not be sent to external services.`
    );
  }
}

/**
 * Privacy compliance summary for audit purposes.
 */
export interface PrivacyCompliance {
  readonly localProcessing: boolean;
  readonly embeddingDataTypes: readonly string[];
  readonly enrichmentDataTypes: readonly string[];
  readonly excludedData: readonly string[];
  readonly verificationEnabled: boolean;
}

/**
 * Get the current privacy compliance status.
 */
export function getPrivacyCompliance(): PrivacyCompliance {
  return {
    localProcessing: true,
    embeddingDataTypes: EXTERNAL_DATA_POLICIES[0].dataTypes,
    enrichmentDataTypes: EXTERNAL_DATA_POLICIES[1].dataTypes,
    excludedData: [
      "full source code",
      "file paths",
      "file content",
      "implementation details",
      "variable values",
      "runtime data",
    ],
    verificationEnabled: true,
  };
}
