Part of the [Connection Pool Tasks](./tasks.md).

# Implementation Tasks (continued)

## Phase 4: Adapter Integration

- [x] 4. Integrate pool with LadybugDatabaseAdapter
  _Skills: `typescript-expert`, `architecture`
  - [x] 4.1 Update `LadybugDatabaseAdapter.initialize()` to acquire connection from pool via `getPool()`
  - [x] 4.2 Update `LadybugDatabaseAdapter.close()` to release connection back to pool instead of closing directly
  - [x] 4.3 Verify graph, vector, and embedding adapters work with pooled connections (no interface changes)

  **Requirements:** 8.1, 6.1

## Phase 5: Consumer Migration

- [x] 5. Update MCP server to use pool
  _Skills: `typescript-expert`, `clean-code`
  - [x] 5.1 Update `src/mcp/server.ts` -- `transport.onclose` calls `drainAllPools()` instead of `adapter.close()`
  - [x] 5.2 Verify concurrent MCP tool calls share the same pool

  **Requirements:** 11.1

- [x] 6. Update CLI executor to use pool-backed adapters
  _Skills: `typescript-expert`, `clean-code`
  - [x] 6.1 Verify `executeIndexingPipeline` works with pool-backed `createDatabaseAdapter`
  - [x] 6.2 Verify `readGraphStatus` works with pool-backed adapter
  - [x] 6.3 Verify obsidian export in `executeCLI` works with pool-backed adapter

  **Requirements:** 11.2

- [x] 7. Update Obsidian CLI entry point
  _Skills: `typescript-expert`, `clean-code`
  - [x] 7.1 Update `src/cli/obsidian-main.ts` to call `drainAllPools()` on process exit
  - [x] 7.2 Verify adapter lifecycle works with pool

  **Requirements:** 11.3

## Phase 6: Backward Compatibility & Cleanup

- [x] 8. Ensure backward compatibility and remove direct connection usage
  _Skills: `typescript-expert`, `clean-code`
  - [x] 8.1 Keep `createLadybugConnection` and `resetConnectionCache` exports unchanged for backward compatibility
  - [x] 8.2 Export new pool-related functions from `src/db/` barrel (if one exists) or document imports
  - [x] 8.3 Verify no production code outside `src/db/` calls `createLadybugConnection` directly

  **Requirements:** 6.1, 11.4
