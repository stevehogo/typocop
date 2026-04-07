Part of the [Schema Prefixes Requirements](./requirements.md).

# Requirements: Operations, Testing & Documentation

## Requirement 10: Prefix Configuration in Environment Files

**User Story:** As a DevOps engineer, I want to configure the prefix in `.env` files, so that I can manage configuration alongside other environment variables.

#### Acceptance Criteria

1. THE Configuration_Manager SHALL read `TYPOCOP_PREFIX` from environment variables or `.env` files.
2. WHERE both an environment variable and a `.env` file define `TYPOCOP_PREFIX`, THE environment variable SHALL take precedence.
3. THE Configuration_Manager SHALL log the loaded prefix at startup (without exposing sensitive values).

## Requirement 11: Prefix Configuration Documentation

**User Story:** As a developer, I want clear documentation on how to configure the prefix, so that I can deploy Typocop correctly.

#### Acceptance Criteria

1. THE Documentation SHALL include examples of setting `TYPOCOP_PREFIX` (e.g., `TYPOCOP_PREFIX=tpc_`).
2. THE Documentation SHALL explain the naming rules for the prefix.
3. THE Documentation SHALL provide examples of deploying multiple Typocop instances to the same database using different prefixes.

5. THE Documentation SHALL include troubleshooting steps for common prefix-related errors.

## Requirement 12: Error Handling for Invalid Prefixes

**User Story:** As a developer, I want clear error messages when the prefix is invalid, so that I can quickly fix configuration issues.

#### Acceptance Criteria

1. IF the prefix is invalid, THEN THE system SHALL throw a Configuration_Error with a message explaining the naming rules.
2. WHEN a Configuration_Error is thrown, THE error message SHALL include the invalid prefix and the reason it was rejected.
3. WHEN a Configuration_Error is thrown, THE error message SHALL suggest a corrected prefix if possible.
4. THE CLI SHALL display Configuration_Errors in a user-friendly format before exiting.

## Requirement 13: Testing Prefixed Database Operations

**User Story:** As a QA engineer, I want comprehensive tests for prefix functionality, so that I can verify that prefixes work correctly.

#### Acceptance Criteria

1. THE Test_Suite SHALL include unit tests for prefix validation rules.
2. THE Test_Suite SHALL include integration tests for creating and querying prefixed tables in PostgreSQL.
3. THE Test_Suite SHALL include integration tests for creating and querying prefixed node labels in Neo4j.
4. THE Test_Suite SHALL include integration tests for creating and querying prefixed relationship types in Neo4j.
5. THE Test_Suite SHALL include tests for multiple Typocop instances with different prefixes in the same database.

## Requirement 14: Prefix Support in Query Builders

**User Story:** As a developer, I want query builders to automatically use the prefix, so that I don't have to manually construct prefixed queries.

#### Acceptance Criteria

1. WHEN a query builder constructs a Cypher query, THE query builder SHALL use the configured prefix for all node labels and relationship types.
2. WHEN a query builder constructs a SQL query, THE query builder SHALL use the configured prefix for all table names.
3. THE query builder SHALL provide a method to get the current prefix.
4. THE query builder SHALL validate that the prefix is set before constructing queries.

## Requirement 16: Logging and Debugging for Prefixes

**User Story:** As a developer, I want to see which prefix is being used in logs, so that I can debug prefix-related issues.

#### Acceptance Criteria

1. WHEN the application initializes, THE Logger SHALL log the configured `TYPOCOP_PREFIX` value.
2. WHEN a database operation is performed, THE Logger SHALL include the prefix in debug logs (if debug logging is enabled).
3. WHEN a prefix validation error occurs, THE Logger SHALL log the error with the invalid prefix and the reason.
4. THE Logger SHALL not log sensitive information (passwords, API keys) alongside prefix configuration.

## Requirement 17: Prefix Support in MCP Tools

**User Story:** As an AI editor user, I want MCP tools to work with prefixed databases, so that I can use Typocop with multiple instances.

#### Acceptance Criteria

1. WHEN an MCP tool is called, THE MCP_Server SHALL use the configured prefix for all database queries.
2. WHEN an MCP tool returns results, THE MCP_Server SHALL strip the prefix from node labels and relationship types in the response.
3. WHEN an MCP tool encounters a prefix configuration error, THE MCP_Server SHALL return a descriptive error message.


## Requirement 18: Prefix Configuration Validation at Startup

**User Story:** As a DevOps engineer, I want the system to validate prefix configuration at startup, so that configuration errors are caught early.

#### Acceptance Criteria

1. WHEN the application starts, THE Configuration_Manager SHALL validate `TYPOCOP_PREFIX`.
2. IF the prefix is invalid, THE application SHALL exit with a clear error message before attempting database operations.
3. THE Configuration_Manager SHALL provide a `validate()` method that can be called independently for testing.
4. WHEN validation succeeds, THE Configuration_Manager SHALL log a success message with the effective prefix value.
