# Security Module

This module implements security controls and privacy protections for the Code Graph Analyzer.

## Components

### Input Sanitization (`sanitize.ts`)

Protects against injection attacks by sanitizing natural language queries before execution.

**Requirements**: 22.3

```typescript
import { sanitizeQuery } from './security/index.js';

const userQuery = "Find all users'; DROP TABLE users; --";
const safe = sanitizeQuery(userQuery);
// Returns sanitized query with malicious patterns removed
```

### Path Validation (`validate-path.ts`)

Prevents directory traversal attacks by validating file paths.

**Requirements**: 22.4

```typescript
import { isValidPath } from './security/index.js';

const userPath = "../../../etc/passwd";
if (!isValidPath(userPath)) {
  throw new Error("Invalid path: directory traversal detected");
}
```

### Privacy Protection (`privacy.ts`)

Ensures no full source code is sent to external services.

**Requirements**: 22.1, 22.2, 24.1

```typescript
import {
  verifyEmbeddingText,
  verifyEnrichmentPrompt,
  getPrivacyCompliance
} from './security/index.js';

// Verify embedding text contains only symbol signatures
const symbolText = formatSymbolForEmbedding(symbol);
verifyEmbeddingText(symbolText, `symbol ${symbol.name}`);

// Verify AI enrichment prompt contains only metadata
const prompt = buildEnrichmentPrompt(cluster, symbols);
verifyEnrichmentPrompt(prompt, `cluster ${cluster.name}`);

// Get privacy compliance status
const compliance = getPrivacyCompliance();
console.log(compliance.localProcessing); // true
```

## Privacy Guarantees

### Local-Only Processing

All code parsing and indexing happens locally:
- Tree-sitter AST parsing
- Six-phase indexing pipeline
- Graph database operations (Neo4j)
- Vector store operations (PostgreSQL + pgvector)
- Query processing

### External Service Data

When external services are enabled (optional):

#### OpenAI Embeddings (Optional)
**Sends**: Symbol signatures only
- Symbol name, kind, signature
- Documentation, visibility, modifiers
- Cluster name, category, confidence

**Does NOT send**:
- Full source code
- File paths
- Implementation details

#### AI Enrichment (Optional)
**Sends**: Symbol names and kinds only
- Heuristic cluster label
- Symbol names (max 20)
- Symbol kinds

**Does NOT send**:
- Full source code
- File paths
- Symbol signatures
- Implementation details

## Verification

All privacy guarantees are enforced by automated verification:

```typescript
// Throws error if source code detected
verifyEmbeddingText(text, context);

// Throws error if file paths detected
verifyEnrichmentPrompt(prompt, context);
```

## Testing

Run security tests:

```bash
# All security tests
pnpm vitest run src/security/

# Privacy tests only
pnpm vitest run src/security/privacy.test.ts

# Sanitization tests
pnpm vitest run src/security/sanitize.test.ts

# Path validation tests
pnpm vitest run src/security/validate-path.test.ts
```

## External Data Policies

All external data policies are documented and queryable:

```typescript
import { EXTERNAL_DATA_POLICIES } from './security/index.js';

for (const policy of EXTERNAL_DATA_POLICIES) {
  console.log(`Service: ${policy.service}`);
  console.log(`Purpose: ${policy.purpose}`);
  console.log(`Data Types: ${policy.dataTypes}`);
  console.log(`Excluded: ${policy.excludedData}`);
}
```

## Compliance

The system provides a compliance status API:

```typescript
import { getPrivacyCompliance } from './security/index.js';

const status = getPrivacyCompliance();
// {
//   localProcessing: true,
//   embeddingDataTypes: [...],
//   enrichmentDataTypes: [...],
//   excludedData: ['full source code', 'file paths', ...],
//   verificationEnabled: true
// }
```

## Integration

### Embedding Module

The embedding module (`src/indexer/search/embed.ts`) integrates privacy verification:

```typescript
export function formatSymbolForEmbedding(symbol: Symbol): string {
  const formatted = /* build symbol text */;
  verifyEmbeddingText(formatted, `symbol ${symbol.name}`);
  return formatted;
}
```

### Cluster Enrichment

The enrichment module (`src/indexer/clustering/enrichment.ts`) integrates privacy verification:

```typescript
export async function inferClusterName(...): Promise<string> {
  const prompt = /* build prompt */;
  verifyEnrichmentPrompt(prompt, `cluster ${heuristicLabel}`);
  return await aiClient.generateText(prompt);
}
```

## Requirements Traceability

| Requirement | Component | Description |
|-------------|-----------|-------------|
| 22.1 | `privacy.ts` | Local-only code processing |
| 22.2 | `privacy.ts` | Symbol signatures only for embeddings |
| 22.3 | `sanitize.ts` | Query input sanitization |
| 22.4 | `validate-path.ts` | Path validation |
| 22.5 | `../mcp/auth.ts` | MCP authentication |
| 24.1 | `privacy.ts` | AI enrichment privacy |

## See Also

- [Privacy Documentation](../../docs/PRIVACY.md) - User-facing privacy documentation
- [Requirements](../../.kiro/specs/code-graph-analyzer/requirements.md) - Security requirements
- [Design](../../.kiro/specs/code-graph-analyzer/design.md) - Security architecture
