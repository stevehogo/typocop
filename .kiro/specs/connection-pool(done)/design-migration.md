Part of the [Connection Pool Design](./design.md).

# Consumer Migration

All production code that currently calls `createDatabaseAdapter` or `adapter.close()` must be updated to work with pool-backed adapters. The key change: `adapter.close()` now releases the connection back to the pool instead of destroying the Database.

## Affected Files

| File | Current Behavior | After Migration |
|------|-----------------|-----------------|
| `src/db/database-adapter.ts` | Calls `createLadybugConnection` directly | Uses `getPool()` to acquire from pool |
| `src/mcp/server.ts` | `adapter.close()` on disconnect | `drainAllPools()` on disconnect |
| `src/cli/executor.ts` | `adapter.close()` in finally blocks | No change needed (pool-backed close = release) |
| `src/cli/obsidian-main.ts` | `adapter.close()` in finally block | Add `drainAllPools()` on process exit |

## MCP Server (`src/mcp/server.ts`)

Long-lived process — most important consumer for pooling. Currently creates one adapter on startup and closes on transport disconnect. After migration:
- Adapter creation unchanged (`createDatabaseAdapter` internally uses pool)
- `transport.onclose` calls `drainAllPools()` for clean shutdown
- Concurrent MCP tool calls benefit from connection reuse

## CLI Executor (`src/cli/executor.ts`)

Short-lived commands. Three call sites:
- `executeIndexingPipeline` — create adapter, use, close (release to pool)
- `readGraphStatus` — create adapter, use, close (release to pool)
- Obsidian export in `executeCLI` — create adapter, use, close (release to pool)

No code changes needed in executor if `createDatabaseAdapter` uses pool internally. The `adapter.close()` calls in `finally` blocks now release to pool instead of destroying.

## Obsidian CLI (`src/cli/obsidian-main.ts`)

Standalone entry point. Same pattern as executor — uses `createDatabaseAdapter`. Add `drainAllPools()` on process exit for clean shutdown.

## `createDatabaseAdapter` Factory (`src/db/database-adapter.ts`)

The factory itself changes to use pool internally:
- `initialize()` acquires from pool via `getPool()`
- `close()` releases to pool
- No external API change — callers don't know about the pool

## Verification

After migration, run:
```bash
grep -r "createLadybugConnection" src/ --include="*.ts" | grep -v "src/db/" | grep -v ".test.ts"
```
Expected: zero results (only `src/db/` and test files should reference it directly).
