# Requirements: Parse Refresh Parameter

## Overview

This document specifies the requirements for adding a `--refresh` parameter to the parse command that enables users to force a complete rebuild of the knowledge graph and embeddings for an indexed codebase.

## Functional Requirements

### 1. CLI Parameter Addition

**Requirement 1.1**: The parse command must accept an optional `--refresh` flag.

- **Acceptance Criteria**:
  - Flag syntax: `-r, --refresh`
  - Flag is optional (default: false)
  - Flag accepts no arguments (boolean flag)
  - Help text: "Clear and rebuild all graph and embeddings data"

**Requirement 1.2**: The CLIConfig interface must include a refresh field.

- **Acceptance Criteria**:
  - Field name: `refresh`
  - Field type: `boolean | undefined`
  - Field is optional (defaults to false)
  - Field is passed from CLI parser to executor

### 2. Graph Data Clearing

**Requirement 2.1**: When `--refresh` is used, all existing Neo4j graph data for the indexed codebase must be cleared.

- **Acceptance Criteria**:
  - All nodes with prefixed labels are deleted
  - All relationships in the graph are deleted
  - Deletion is scoped to the configured prefix
  - Deletion completes before indexing begins
  - Deletion is idempotent (safe to call multiple times)

**Requirement 2.2**: Graph clearing must handle errors gracefully.

- **Acceptance Criteria**:
  - If deletion fails, error is logged with details
  - Pipeline halts on deletion failure
  - User receives clear error message
  - No partial state is left behind

### 3. Vector Data Clearing

**Requirement 3.1**: When `--refresh` is used, all existing pgvector embeddings for the indexed codebase must be cleared.

- **Acceptance Criteria**:
  - All embeddings for the prefix are deleted from pgvector
  - Deletion is scoped to the configured prefix
  - Deletion completes before indexing begins
  - Deletion is idempotent (safe to call multiple times)

**Requirement 3.2**: Vector clearing must handle errors gracefully.

- **Acceptance Criteria**:
  - If deletion fails, error is logged with details
  - Pipeline halts on deletion failure
  - User receives clear error message
  - No partial state is left behind

### 4. Indexing Pipeline Integration

**Requirement 4.1**: The refresh flag must integrate seamlessly with the existing indexing pipeline.

- **Acceptance Criteria**:
  - When `refresh === true`, clearing happens before Phase 1
  - When `refresh === false` (default), clearing is skipped
  - Indexing pipeline (Phases 1-6) executes identically regardless of refresh flag
  - All existing indexing statistics are reported

**Requirement 4.2**: The refresh operation must be atomic from a user perspective.

- **Acceptance Criteria**:
  - Clearing and indexing are treated as a single operation
  - User sees single progress indicator
  - Statistics reflect the complete refresh operation
  - No intermediate state is visible to user

### 5. Backward Compatibility

**Requirement 5.1**: The refresh parameter must be fully backward compatible.

- **Acceptance Criteria**:
  - Existing parse commands work unchanged (without `--refresh`)
  - Default behavior is incremental/update (no clearing)
  - No breaking changes to CLIConfig interface
  - No breaking changes to executor function signature

**Requirement 5.2**: The refresh parameter must not affect other commands.

- **Acceptance Criteria**:
  - `reindex` command is unaffected
  - `status` command is unaffected
  - Only `parse` command supports `--refresh`

### 6. Logging and Feedback

**Requirement 6.1**: The refresh operation must provide clear user feedback.

- **Acceptance Criteria**:
  - When `--refresh` is used, user sees confirmation message
  - Clearing progress is logged (nodes/relationships/embeddings deleted)
  - Verbose mode (`-v`) provides detailed clearing information
  - Final statistics show complete refresh results

**Requirement 6.2**: Errors during clearing must be clearly communicated.

- **Acceptance Criteria**:
  - Error messages include operation (graph or vector clearing)
  - Error messages include reason for failure
  - Error messages suggest recovery steps
  - Errors are logged to stderr

## Non-Functional Requirements

### 7. Performance

**Requirement 7.1**: Graph clearing must complete efficiently.

- **Acceptance Criteria**:
  - Clearing < 1s for typical codebases (< 10k symbols)
  - Clearing scales linearly with graph size
  - No performance degradation to indexing pipeline

**Requirement 7.2**: Vector clearing must complete efficiently.

- **Acceptance Criteria**:
  - Clearing < 1s for typical codebases (< 10k embeddings)
  - Clearing scales linearly with embedding count
  - No performance degradation to indexing pipeline

### 8. Reliability

**Requirement 8.1**: Clearing operations must be reliable and idempotent.

- **Acceptance Criteria**:
  - Clearing can be safely retried without side effects
  - Partial clearing is handled gracefully
  - No data corruption on failure
  - Database remains in consistent state

**Requirement 8.2**: The refresh operation must handle concurrent access.

- **Acceptance Criteria**:
  - Clearing uses appropriate database locks
  - No race conditions with other operations
  - Transactions are properly isolated

### 9. Security

**Requirement 9.1**: Clearing must be scoped to the configured prefix.

- **Acceptance Criteria**:
  - Only data for the current prefix is deleted
  - Data from other prefixes is preserved
  - No cross-prefix data leakage

**Requirement 9.2**: Clearing must require valid database credentials.

- **Acceptance Criteria**:
  - Same authentication as normal parse operation
  - No additional credentials required
  - No privilege escalation

### 10. Usability

**Requirement 10.1**: The refresh flag must be discoverable and intuitive.

- **Acceptance Criteria**:
  - Flag appears in `--help` output
  - Help text clearly explains purpose
  - Flag name is intuitive (`--refresh`)
  - Short form (`-r`) is available

**Requirement 10.2**: The refresh operation must be safe to use.

- **Acceptance Criteria**:
  - Accidental use doesn't cause data loss (user must explicitly use flag)
  - Clear confirmation in output when refresh is used
  - No silent data deletion

## Acceptance Criteria Summary

| Requirement | Acceptance Criteria | Status |
|-------------|-------------------|--------|
| 1.1 | CLI parameter added with correct syntax | Pending |
| 1.2 | CLIConfig interface updated | Pending |
| 2.1 | Graph data cleared when --refresh used | Pending |
| 2.2 | Graph clearing errors handled | Pending |
| 3.1 | Vector data cleared when --refresh used | Pending |
| 3.2 | Vector clearing errors handled | Pending |
| 4.1 | Refresh integrates with pipeline | Pending |
| 4.2 | Refresh operation is atomic | Pending |
| 5.1 | Backward compatible | Pending |
| 5.2 | Other commands unaffected | Pending |
| 6.1 | User feedback provided | Pending |
| 6.2 | Errors clearly communicated | Pending |
| 7.1 | Graph clearing performant | Pending |
| 7.2 | Vector clearing performant | Pending |
| 8.1 | Clearing reliable and idempotent | Pending |
| 8.2 | Concurrent access handled | Pending |
| 9.1 | Clearing scoped to prefix | Pending |
| 9.2 | Clearing requires valid credentials | Pending |
| 10.1 | Flag discoverable and intuitive | Pending |
| 10.2 | Refresh operation safe | Pending |
