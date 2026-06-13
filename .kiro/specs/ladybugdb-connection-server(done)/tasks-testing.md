Part of the [Implementation Plan](./tasks.md).

# Testing Tasks

## Tasks

- [x] 12. Property-based tests for correctness properties (Phase 7)
  _Skills: `testing-patterns`, `typescript-expert`
  - [x]* 12.1 Write property test: Adapter factory mode selection (Property 1)
    - **Property 1: Adapter factory mode selection**
    - ∀ valid config, `createDatabaseAdapter` returns correct adapter type by `runtimeMode`
    - **Validates: Requirements 1.1, 9.1, 9.2, 9.3**
  - [x]* 12.2 Write property test: Configuration validation rejects invalid inputs (Property 2)
    - **Property 2: Configuration validation rejects invalid inputs**
    - ∀ config with invalid `serverUrl`, `port`, `maxConcurrency`, or `maxQueue`, loader rejects
    - **Validates: Requirements 1.3, 1.4, 9.4**
  - [x]* 12.3 Write property test: Configuration defaults applied (Property 3)
    - **Property 3: Configuration defaults applied for missing env vars**
    - ∀ subset of env vars, missing variables resolve to documented defaults
    - **Validates: Requirement 1.2**
  - [x]* 12.4 Write property test: Concurrency bound invariant (Property 4)
    - **Property 4: Concurrency bound invariant**
    - ∀ sequence of enqueued requests, `inFlight` never exceeds `maxConcurrency`
    - **Validates: Requirement 4.1**
  - [x]* 12.5 Write property test: Queue bound invariant (Property 5)
    - **Property 5: Queue bound invariant**
    - ∀ sequence of enqueued requests, `queue.length` never exceeds `maxQueue`
    - **Validates: Requirements 4.2, 4.3**
  - [x]* 12.6 Write property test: Priority ordering (Property 6)
    - **Property 6: Priority ordering**
    - ∀ mixed-priority batch at capacity, higher-priority requests execute first
    - **Validates: Requirement 4.4**
  - [x]* 12.7 Write property test: Timeout guarantee (Property 7)
    - **Property 7: Timeout guarantee**
    - ∀ request with `timeoutMs`, completes or rejects within timeout + overhead
    - **Validates: Requirement 4.5**
  - [x]* 12.8 Write property test: Prefix isolation (Property 8)
    - **Property 8: Prefix isolation**
    - ∀ gRPC request, OperationRouter scopes to caller's prefix; adapter includes prefix
    - **Validates: Requirements 3.5, 8.1, 8.4**
  - [x]* 12.9 Write property test: Lock release guarantee (Property 9)
    - **Property 9: Lock release guarantee**
    - ∀ autostart attempt (including failures), cross-process lock is released
    - **Validates: Requirement 7.5**
  - [x]* 12.10 Write property test: GraphNode serialization round-trip (Property 10)
    - **Property 10: GraphNode serialization round-trip**
    - ∀ valid `GraphNode`, serialize to protobuf and deserialize back produces equivalent object
    - **Validates: Requirement 10.1**
  - [x]* 12.11 Write property test: SearchResult serialization round-trip (Property 11)
    - **Property 11: SearchResult serialization round-trip**
    - ∀ valid `SearchResult`, serialize to protobuf and deserialize back produces equivalent object
    - **Validates: Requirement 10.2**
  - [x]* 12.12 Write property test: Error-to-gRPC-status mapping (Property 12)
    - **Property 12: Error-to-gRPC-status mapping**
    - ∀ server-side error, maps to correct gRPC status with structured `ErrorDetail`
    - **Validates: Requirement 10.3**
  - [x]* 12.13 Write property test: Prefix-scoped path defaults (Property 14)
    - **Property 14: Prefix-scoped path defaults**
    - ∀ `TYPOCOP_PREFIX`, derived paths contain the prefix
    - **Validates: Requirement 8.2**

- [x] 13. Checkpoint — Verify property tests pass
  - Ensure all property-based tests pass with `pnpm vitest --run`. Ask the user if questions arise.

- [x] 14. Integration tests (Phase 8)
  _Skills: `testing-patterns`, `typescript-expert`, `nodejs-best-practices`
  - [x]* 14.1 Write integration test: single server with concurrent clients
    - Start connection server, connect MCP/query/CLI-style clients concurrently, verify operations succeed
    - _Requirements: 3.3, 3.4, 6.2_
  - [x]* 14.2 Write integration test: graceful shutdown with in-flight requests
    - Send requests, trigger SIGTERM, verify drain completes and WAL flushes
    - _Requirements: 3.7, 4.6_
  - [x]* 14.3 Write integration test: priority scheduling under load
    - Saturate scheduler, verify admin > interactive_read > background_write ordering
    - _Requirements: 4.4_
  - [x]* 14.4 Write integration test: autostart with multiple simultaneous clients
    - Multiple clients detect server down, verify only one server spawns via lock coordination
    - _Requirements: 7.1, 7.2, 7.5_
  - [x]* 14.5 Write integration test: response equivalence (local vs remote adapter)
    - Run same operations through `LadybugDatabaseAdapter` and `RemoteDatabaseAdapter`, compare results
    - _Requirements: 6.2, 10.1, 10.2_
  - [x]* 14.6 Write integration test: auth token enforcement
    - Verify requests without valid token are rejected when `LADYBUG_SERVER_AUTH_TOKEN` is set
    - _Requirements: 5.4_

- [x] 15. Final checkpoint — Ensure all tests pass
  - Run `pnpm vitest --run` and verify all unit, property, and integration tests pass. Ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Property tests validate universal correctness properties from design-properties.md
- Checkpoints ensure incremental validation between phases
- All code uses TypeScript strict mode with `@grpc/grpc-js` for gRPC transport
