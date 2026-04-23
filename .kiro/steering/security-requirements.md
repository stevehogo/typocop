---
inclusion: fileMatch
fileMatchPattern: "src/**"
---

# Security Requirements

Security rules specific to the Code Graph Analyzer project (derived from Requirements 22.1-22.5).

## Code Security Rules

### 1. Never Send Full Source Code to External APIs (Req 22.2)

Only send symbol signatures to embedding services for embeddings and enrichment — never full source code.

```typescript
// Good — only signature
const signature = `function ${symbol.name}(${params}): ${returnType}`;
const embedding = await embeddingAdapter.embedText(signature);

// Bad — full source code
const embedding = await embeddingAdapter.embedText(fileContent);  // NEVER do this
```

### 2. Sanitize All Query Inputs (Req 22.3)

Sanitize natural language queries before executing graph database queries:

```typescript
function sanitizeQuery(query: string): string {
  // Remove Cypher injection patterns
  return query
    .replace(/[;'"\\]/g, "")           // Remove special chars
    .replace(/\b(MATCH|CREATE|DELETE|SET|REMOVE)\b/gi, "")  // Remove Cypher keywords
    .trim();
}

// Use in query execution
export async function executeQuery(query: Query): Promise<QueryResult> {
  const sanitized = sanitizeQuery(query.text);
  // ... execute with sanitized input
}
```

### 3. Validate All File Paths (Req 22.4)

Prevent directory traversal attacks:

```typescript
import { resolve, normalize } from "node:path";

function validateFilePath(path: string, repoRoot: string): boolean {
  const normalized = normalize(path);
  const resolved = resolve(repoRoot, normalized);
  
  // Must be within repo root
  if (!resolved.startsWith(repoRoot)) {
    throw new Error(`Path traversal detected: ${path}`);
  }
  
  // No parent directory references
  if (normalized.includes("..")) {
    throw new Error(`Invalid path: ${path}`);
  }
  
  return true;
}

// Use in file operations
export async function parseFile(filePath: string, repoRoot: string): Promise<Symbol[]> {
  validateFilePath(filePath, repoRoot);
  // ... proceed with parsing
}
```

### 4. MCP Server Authentication (Req 22.5)

Require token-based authentication for MCP connections:

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

const server = new Server(
  {
    name: "code-graph-analyzer",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Validate auth token on every request
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const token = extra?.meta?.authToken;
  
  if (!token || !isValidToken(token)) {
    throw new Error("Unauthorized: Invalid or missing auth token");
  }
  
  // ... proceed with request
});

function isValidToken(token: string): boolean {
  const validToken = process.env.MCP_AUTH_TOKEN;
  return token === validToken;
}
```

### 5. Environment Variables for Secrets

Never hardcode secrets — use environment variables:

```typescript
// Good
const ollamaUrl = process.env.OLLAMA_URL;

if (!ollamaUrl) {
  throw new Error("Missing required environment variables");
}

// Bad
const dbPassword = "password123";  // NEVER do this
```

## Dependency Security

- Keep all dependencies updated
- Use `pnpm audit` to scan for vulnerabilities
- Review third-party packages before adding
- Use lock files (`pnpm-lock.yaml`) for reproducible builds
- Remove unused dependencies

```bash
# Check for vulnerabilities
pnpm audit

# Update dependencies
pnpm update

# Check for outdated packages
pnpm outdated
```

## Data Protection

### Database Credentials

Store database credentials in environment variables, never in code:

```bash
# .env (never commit this file)
TYPOCOP_PREFIX=tpc_
OLLAMA_ENABLED=true
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=mxbai-embed-large
OLLAMA_DIMENSIONS=1024
MCP_AUTH_TOKEN=your-secure-token
```

### Logging Security

Never log sensitive information:

```typescript
// Good
logger.info("Connected to LadybugDB", { dbPath });

// Bad
logger.info("Connected to LadybugDB", { 
  dbPath, 
  password: dbPassword  // NEVER log passwords
});
```

## Input Validation

Validate all external inputs:

```typescript
function validateQuery(query: Query): void {
  if (!query.text || query.text.trim().length === 0) {
    throw new Error("Query text cannot be empty");
  }
  
  if (query.maxResults <= 0 || query.maxResults > 1000) {
    throw new Error("maxResults must be between 1 and 1000");
  }
}

function validateSymbolId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error("Invalid symbol ID format");
  }
}
```

## Error Handling

Don't leak sensitive information in error messages:

```typescript
// Good
catch (error) {
  logger.error("Database connection failed");
  throw new Error("Database connection failed");
}

// Bad
catch (error) {
  throw new Error(`Failed to connect to database at ${dbPath}`);
  // Leaks connection details
}
```

## Security Checklist

Before deploying:

- [ ] All secrets in environment variables
- [ ] All query inputs sanitized
- [ ] All file paths validated
- [ ] MCP server authentication enabled
- [ ] No full source code sent to external APIs
- [ ] Dependencies scanned for vulnerabilities
- [ ] Error messages don't leak sensitive info
- [ ] Logging doesn't include secrets
- [ ] `.env` file in `.gitignore`
- [ ] Database connections use TLS/SSL in production
