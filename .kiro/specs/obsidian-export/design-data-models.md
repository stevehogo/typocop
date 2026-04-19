Part of the [Obsidian Export Design](./design.md).

# Data Models & Output Formats

## Markdown Output Formats

### Symbol File Format

```markdown
---
source_file: src/cli/parser.ts
symbol_count: 5
clusters:
  - cli-infrastructure
last_exported: 2024-01-15T10:30:00Z
---

# src/cli/parser.ts

## parseArgs

| Property | Value |
|----------|-------|
| Kind | function |
| Visibility | public |
| Lines | 45–102 |
| Signature | `parseArgs(rawArgs: string[]): CLICommand` |
| Cluster | [[cli-infrastructure]] |
| Callers | 2 |

**Calls**: [[executeCLI]], [[detectDirectoryLanguage]]
**Called by**: [[main]]
```

### Cluster File Format

```markdown
---
type: cluster
category: authentication
confidence: 0.87
symbol_count: 12
---

# Cluster: Authentication

**Category**: authentication  |  **Confidence**: 0.87  |  **Symbols**: 12

## Members

- [[src/auth/login]] > `authenticateUser`
- [[src/auth/token]] > `generateToken`
```

### Process File Format (with Mermaid)

```markdown
---
type: process
entry_point: handleLoginRequest
step_count: 5
---

# Process: User Login Flow

**Entry Point**: [[handleLoginRequest]]  |  **Steps**: 5

## Data Flow

```mermaid
graph LR
    A[handleLoginRequest] -->|credentials| B[authenticateUser]
    B -->|userId| C[generateToken]
    C -->|token| D[setSessionCookie]
```

## Steps

1. [[handleLoginRequest]] — Receives HTTP request
2. [[authenticateUser]] — Validates credentials
```

## Helper Functions

```typescript
function sourcePathToVaultPath(filePath: string): string {
  // src/cli/parser.ts → src/cli/parser.md
  return filePath.replace(/\.[^.]+$/, ".md");
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function sanitizeMermaidId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

function stripPrefix(relType: string, prefix: string): string {
  return relType.startsWith(prefix) ? relType.slice(prefix.length) : relType;
}
```
