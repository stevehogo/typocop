# Privacy and Data Protection

## Overview

The Code Graph Analyzer follows strict privacy principles to ensure that your source code remains private and secure. All code processing happens locally, and only minimal metadata is sent to external services when explicitly enabled.

## Privacy Principles

### 1. Local-Only Code Processing (Requirement 22.1)

All parsing and indexing operations execute entirely on your local machine or in infrastructure you control:

- **AST Parsing**: Uses tree-sitter locally to parse source files
- **Six-Phase Indexing**: All phases (structure, parsing, resolution, clustering, processes, search) run locally
- **Graph Database**: Neo4j runs locally or in your controlled infrastructure
- **Vector Store**: PostgreSQL with pgvector runs locally or in your controlled infrastructure
- **Query Processing**: Natural language queries are processed locally

**No source code is ever transmitted to external services.**

### 2. Symbol Signatures Only for Embeddings (Requirement 22.2)

When using external embedding APIs (OpenAI text-embedding-3-large), only symbol signatures are sent:

#### What IS Sent:
- Symbol name (e.g., `getUserById`)
- Symbol kind (e.g., `function`, `class`, `method`)
- Symbol signature (e.g., `(id: string) => Promise<User>`)
- Symbol documentation (JSDoc comments)
- Symbol visibility (`public`, `private`, `protected`)
- Symbol modifiers (`static`, `async`, `readonly`)
- Cluster metadata (name, category, confidence score)

#### What is NOT Sent:
- Full source code
- File paths
- File content
- Implementation details
- Variable values
- Runtime data
- Any code beyond the signature

#### Example of Data Sent to Embedding API:

```
function: getUserById
signature: (id: string) => Promise<User>
visibility: public
modifiers: async
docs: Retrieves a user by their unique identifier
```

### 3. AI Enrichment (Optional, Requirement 24.1)

When AI enrichment is enabled for cluster naming, only minimal metadata is sent:

#### What IS Sent:
- Heuristic cluster label (e.g., "OrderProcessing")
- Symbol names (maximum 20 symbols)
- Symbol kinds (e.g., `function`, `class`)

#### What is NOT Sent:
- Full source code
- File paths
- Symbol signatures
- Implementation details
- Variable values

#### Example of Data Sent for AI Enrichment:

```
You are a software architect. Name this code cluster in 2–4 words.
Heuristic: "OrderProcessing"
Members: processOrder (function), OrderService (class), validateOrder (function)
Reply with ONLY the name, no punctuation.
```

## Privacy Verification

The system includes automated privacy verification to prevent accidental data leakage:

### Embedding Text Verification

Before sending any text to the embedding API, the system verifies:
1. No source code patterns are present (function bodies, class implementations, etc.)
2. No file paths are included
3. Only symbol metadata is present

```typescript
import { verifyEmbeddingText } from './security/privacy.js';

const symbolText = formatSymbolForEmbedding(symbol);
verifyEmbeddingText(symbolText, `symbol ${symbol.name}`);
// Throws error if source code or file paths detected
```

### AI Enrichment Verification

Before sending prompts to AI services, the system verifies:
1. No source code patterns are present
2. No file paths are included
3. Only symbol names and kinds are present

```typescript
import { verifyEnrichmentPrompt } from './security/privacy.js';

const prompt = buildEnrichmentPrompt(cluster, symbols);
verifyEnrichmentPrompt(prompt, `cluster ${cluster.name}`);
// Throws error if source code or file paths detected
```

## External Service Configuration

### Disabling External Services

You can run the Code Graph Analyzer entirely offline by:

1. **Disabling Embeddings**: Don't provide an OpenAI API key
   - The system will fall back to keyword-only search
   - All functionality remains available except semantic search

2. **Disabling AI Enrichment**: Don't provide an AI client
   - Clusters will use heuristic names based on folder structure
   - All functionality remains available with slightly less descriptive names

### Environment Variables

```bash
# Optional: Enable semantic search (sends only symbol signatures)
OPENAI_API_KEY=your-api-key-here

# Optional: Enable AI enrichment (sends only symbol names/kinds)
AI_ENRICHMENT_ENABLED=true
```

## Privacy Compliance Status

You can query the current privacy compliance status programmatically:

```typescript
import { getPrivacyCompliance } from './security/privacy.js';

const compliance = getPrivacyCompliance();
console.log(compliance);
// {
//   localProcessing: true,
//   embeddingDataTypes: ['symbol name', 'symbol kind', ...],
//   enrichmentDataTypes: ['heuristic cluster label', ...],
//   excludedData: ['full source code', 'file paths', ...],
//   verificationEnabled: true
// }
```

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     LOCAL PROCESSING                         │
│                                                              │
│  Source Code → Tree-sitter → AST → 6-Phase Indexer         │
│                                         ↓                    │
│                                    Neo4j (local)             │
│                                    PostgreSQL (local)        │
│                                         ↓                    │
│                                    Query Server              │
└─────────────────────────────────────────────────────────────┘
                                    ↓
                    ┌───────────────┴───────────────┐
                    │                               │
         (Optional) │                    (Optional) │
                    ↓                               ↓
        ┌────────────────────┐         ┌────────────────────┐
        │  OpenAI Embeddings │         │  AI Enrichment     │
        │                    │         │                    │
        │  Receives:         │         │  Receives:         │
        │  - Symbol names    │         │  - Symbol names    │
        │  - Symbol kinds    │         │  - Symbol kinds    │
        │  - Signatures      │         │  - Cluster labels  │
        │  - Documentation   │         │                    │
        │                    │         │  Max 20 symbols    │
        │  Does NOT receive: │         │                    │
        │  - Source code     │         │  Does NOT receive: │
        │  - File paths      │         │  - Source code     │
        │  - Implementation  │         │  - File paths      │
        └────────────────────┘         └────────────────────┘
```

## Security Best Practices

1. **Run Locally**: Deploy Neo4j and PostgreSQL locally or in your controlled infrastructure
2. **API Key Security**: Store API keys in environment variables, never in code
3. **Network Isolation**: Run the system in a network-isolated environment if handling sensitive code
4. **Audit Logs**: Enable logging to track all external API calls
5. **Review Policies**: Regularly review the external data policies in `src/security/privacy.ts`

## Compliance and Auditing

### External Data Policies

All external data policies are documented in code:

```typescript
import { EXTERNAL_DATA_POLICIES } from './security/privacy.js';

for (const policy of EXTERNAL_DATA_POLICIES) {
  console.log(`Service: ${policy.service}`);
  console.log(`Data Types: ${policy.dataTypes.join(', ')}`);
  console.log(`Excluded: ${policy.excludedData.join(', ')}`);
  console.log(`Purpose: ${policy.purpose}`);
}
```

### Verification Tests

All privacy guarantees are enforced by automated tests:

```bash
# Run privacy verification tests
pnpm vitest run src/security/privacy.test.ts

# Run all security tests
pnpm vitest run src/security/
```

## Questions and Support

If you have questions about privacy or data protection:

1. Review this document
2. Check the source code in `src/security/privacy.ts`
3. Run the privacy compliance query: `getPrivacyCompliance()`
4. Review the test suite in `src/security/privacy.test.ts`

## License and Warranty

This software is provided as-is. While we implement strict privacy controls, you are responsible for:
- Securing your API keys
- Controlling access to your infrastructure
- Reviewing and approving any external service usage
- Compliance with your organization's security policies
