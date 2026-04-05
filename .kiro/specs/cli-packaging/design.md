# CLI Packaging Design

## Overview

This document describes the technical design for packaging Typocop as a distributable CLI tool. The project already has working CLI logic in `src/cli/` and an MCP server in `src/mcp/`. This feature adds the thin entry point files, `package.json` wiring, build pipeline scripts, and distribution metadata needed to make those modules installable and runnable as global binaries.

The two published binaries are:
- `typocop` — invokes the CLI indexer (`src/cli/`)
- `typocop-mcp` — starts the MCP server (`src/mcp/`)

## Architecture

```
npm registry
    ↓  pnpm add -g typocop
~/.local/share/pnpm/global/
    dist/cli/main.js   ← typocop binary
    dist/mcp/main.js   ← typocop-mcp binary
         ↓
    src/cli/index.ts   (parseArgs, executeCLI)
    src/mcp/index.ts   (startMCPServer)
```

Build flow:

```
pnpm run build
    └─ tsc  →  dist/
    └─ postbuild: chmod +x dist/cli/main.js dist/mcp/main.js

pnpm publish
    └─ prepublishOnly: pnpm run build
    └─ pack: dist/, README.md  (files field)
```

## Components and Interfaces

### `src/cli/main.ts` — CLI entry point

New file. Thin wrapper that calls into the existing `src/cli/` module. Parses `-e/--env` from argv before delegating to `parseArgs`.

```typescript
#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseArgs, executeCLI, CLIValidationError } from "./index.js";

async function main(): Promise<void> {
  // Strip -e/--env <path> from argv before passing to parseArgs
  const argv = process.argv.slice(2);
  let envPath: string | undefined;
  const filteredArgv: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === "-e" || argv[i] === "--env") && i + 1 < argv.length) {
      envPath = argv[++i];
    } else {
      filteredArgv.push(argv[i]);
    }
  }

  if (envPath !== undefined) {
    if (!existsSync(envPath)) {
      process.stderr.write(`Error: env file not found: ${envPath}\n`);
      process.exit(1);
    }
    const { config } = await import("dotenv");
    config({ path: envPath });
  }

  let command;
  try {
    command = parseArgs(["node", "typocop", ...filteredArgv]);
  } catch (err) {
    if (err instanceof CLIValidationError) {
      process.stderr.write(err.message + "\n");
      process.exit(1);
    }
    throw err;
  }

  try {
    await executeCLI(command);
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(msg + "\n");
    process.exit(1);
  }
}

main();
```

### `src/mcp/main.ts` — MCP server entry point

New file. Thin wrapper that calls `startMCPServer`. Parses `-e/--env` from argv before starting the server.

```typescript
#!/usr/bin/env node
import { existsSync } from "node:fs";
import { startMCPServer } from "./index.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let envPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === "-e" || argv[i] === "--env") && i + 1 < argv.length) {
      envPath = argv[++i];
      break;
    }
  }

  if (envPath !== undefined) {
    if (!existsSync(envPath)) {
      process.stderr.write(`Error: env file not found: ${envPath}\n`);
      process.exit(1);
    }
    const { config } = await import("dotenv");
    config({ path: envPath });
  }

  await startMCPServer();
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(msg + "\n");
  process.exit(1);
});
```

### `package.json` changes

| Field | Value |
|---|---|
| `bin.typocop` | `"dist/cli/main.js"` |
| `bin.typocop-mcp` | `"dist/mcp/main.js"` |
| `files` | `["dist", "README.md"]` |
| `engines.node` | `">=20.0.0"` |
| `scripts.prepublishOnly` | `"pnpm run build"` |
| `scripts.postbuild` | `"chmod +x dist/cli/main.js dist/mcp/main.js"` |
| `scripts.clean` | `"rm -rf dist"` |

The `build` script already runs `tsc`. The `postbuild` hook runs automatically after `build` completes.

### Dependencies

`dotenv` must be declared as a **runtime dependency** (not devDependency) so it is available after a global install:

```json
"dependencies": {
  "dotenv": "^16.0.0"
}
```

### `.env.example`

Documents all supported environment variables with their defaults:

```
# Neo4j graph database
NEO4J_URI=bolt://localhost:8687
NEO4J_USER=neo4j
NEO4J_PASSWORD=password

# PostgreSQL vector store
POSTGRES_HOST=localhost
POSTGRES_PORT=8432
POSTGRES_DB=typocop
POSTGRES_USER=postgres
POSTGRES_PASSWORD=password

# OpenAI embeddings
OPENAI_API_KEY=sk-...
```

## Data Models

No new data models. The entry points are pure orchestration — they delegate entirely to `parseArgs`, `executeCLI`, and `startMCPServer`.

Environment variable defaults are already defined in `src/cli/executor.ts` (`getDatabaseConfig`) and `src/mcp/server.ts`. The `.env.example` documents those same defaults.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

Most acceptance criteria in this feature are configuration checks (SMOKE) or integration checks (INTEGRATION) that do not benefit from property-based testing. Three criteria are amenable to PBT:

**Property reflection**: Properties 1 and 2 both test "any error → stderr + exit 1" but for different entry points. They are structurally identical and can be unified into one property per entry point. Properties 1 and 2 remain distinct because they test different modules. Property 3 (unknown command) is independent.

### Property 1: CLI entry point propagates any error to stderr

*For any* `Error` with any message string, when `executeCLI` rejects with that error, the CLI entry point SHALL write the message to stderr and exit with code 1.

**Validates: Requirements 1.4, 1.5**

### Property 2: MCP entry point propagates any error to stderr

*For any* `Error` with any message string, when `startMCPServer` rejects with that error, the MCP entry point SHALL write the message to stderr and exit with code 1.

**Validates: Requirements 5.3**

### Property 3: Unknown commands always exit with code 1

*For any* string that is not one of the valid command names (`parse`, `reindex`, `status`), passing it as the first positional argument to `parseArgs` SHALL result in a `CLIValidationError` being thrown or the process exiting with code 1.

**Validates: Requirements 7.4**

### Property 4: Env_Flag file-not-found always exits with code 1

*For any* path string that does not exist on the filesystem, passing it via `-e <path>` to either `typocop` or `typocop-mcp` SHALL cause the entry point to write an error message to stderr and exit with code 1, without invoking `parseArgs`, `executeCLI`, or `startMCPServer`.

**Validates: Requirements 9.5, 9.6**

## Error Handling

| Scenario | Behavior |
|---|---|
| `parseArgs` throws `CLIValidationError` | Print `err.message` to stderr, exit 1 |
| `executeCLI` throws any error | Print `err.message` to stderr, exit 1 |
| `startMCPServer` rejects | Print `err.message` to stderr, exit 1 |
| `-e <path>` provided, file does not exist | Print error to stderr, exit 1 (before any parsing) |
| `-e <path>` provided, file exists | Load via `dotenv.config({ path })`, then proceed normally |
| Successful CLI command | Exit 0 |
| MCP server running | Process stays alive (no exit) |

The entry points do not catch errors from `parseArgs` that are not `CLIValidationError` — those bubble up as unhandled rejections, which Node.js will report and exit non-zero by default.

## Testing Strategy

### Unit tests (`src/cli/main.test.ts`, `src/mcp/main.test.ts`)

- Mock `parseArgs` and `executeCLI` / `startMCPServer` using `vi.mock`
- Mock `node:fs` `existsSync` and `dotenv` `config` for `-e` flag tests
- Test success path: verify `process.exit(0)` is called
- Test `CLIValidationError` path: verify stderr write + `process.exit(1)`
- Test unexpected error path: verify stderr write + `process.exit(1)`
- Test MCP success: verify process does not exit
- Test `-e <path>` with existing file: verify `dotenv.config` called before `parseArgs`/`startMCPServer`
- Test `-e <path>` with missing file: verify stderr write + `process.exit(1)` without calling downstream

### Property-based tests (fast-check, min 100 iterations each)

```typescript
// Feature: cli-packaging, Property 1: CLI entry point propagates any error to stderr
fc.assert(fc.property(fc.string(), async (msg) => {
  // mock executeCLI to reject with new Error(msg)
  // run main(), capture stderr, assert msg present and exit code 1
}), { numRuns: 100 });

// Feature: cli-packaging, Property 2: MCP entry point propagates any error to stderr
fc.assert(fc.property(fc.string(), async (msg) => {
  // mock startMCPServer to reject with new Error(msg)
  // run mcp main(), capture stderr, assert msg present and exit code 1
}), { numRuns: 100 });

// Feature: cli-packaging, Property 3: Unknown commands always exit with code 1
fc.assert(fc.property(
  fc.string().filter(s => !["parse","reindex","status"].includes(s)),
  (cmd) => {
    expect(() => parseArgs(["node", "typocop", cmd])).toThrow(CLIValidationError);
  }
), { numRuns: 100 });

// Feature: cli-packaging, Property 4: Env_Flag file-not-found always exits with code 1
fc.assert(fc.property(fc.string(), async (path) => {
  // mock existsSync to return false for any path
  // run CLI main() with ["-e", path], assert stderr write + exit code 1
  // assert parseArgs and executeCLI were NOT called
}), { numRuns: 100 });
// Same property repeated for MCP main()
```

### Smoke tests (configuration assertions)

Verify `package.json` fields: `bin`, `files`, `engines`, `scripts.build`, `scripts.prepublishOnly`, `scripts.postbuild`, `scripts.clean`, `type: "module"`, and `dependencies.dotenv`.

Verify shebang lines in compiled `dist/cli/main.js` and `dist/mcp/main.js` after build.

Verify `.env.example` exists and contains all nine variable names.

### Integration tests

- Run `pnpm run build` and assert `dist/cli/main.js` and `dist/mcp/main.js` exist
- Assert both files have executable permission bits set (POSIX only)
- Run `pnpm pack --dry-run` and assert `src/` is not included
