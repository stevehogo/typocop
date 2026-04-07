# Implementation Tasks: Schema Prefixes

## Phase 1: Core Infrastructure

- [x] 1. Implement Prefix Validator
  _Skills: `typescript-expert`, `clean-code`
  - [x] 1.1 Create unified prefix validation (pattern `^[a-z][a-z0-9_]*$`, length, normalization)
  - [x] 1.2 Implement auto-append underscore normalization
  - [x] 1.3 Implement error messages with suggestions
  - [x] 1.4 Add unit tests for all validation rules

- [x] 2. Implement Configuration Manager
  _Skills: `typescript-expert`, `architecture`, `error-handling-patterns`
  - [x] 2.1 Create Configuration_Manager class with single `TYPOCOP_PREFIX` env var
  - [x] 2.2 Implement default resolution (`tpc_` when unset)
  - [x] 2.3 Implement prefix validation and normalization
  - [x] 2.4 Implement propagation of single prefix to both Vector_Store and Graph_Store
  - [x] 2.5 Add unit tests for configuration loading and default resolution

- [x] 3. Write property-based tests for prefix validation
  _Skills: `testing-patterns`
  - [x] 3.1 Property test: Prefix validation correctness (unified rules)
  - [x] 3.2 Property test: Default resolution (`tpc_` when unset)
  - [x] 3.3 Property test: Prefix normalization idempotence

## Phase 2: PostgreSQL Integration

- [x] 4. Modify Vector_Store for prefix support
  _Skills: `typescript-expert`, `postgresql`, `clean-code`
  - [x] 4.1 Add prefix parameter to constructor
  - [x] 4.2 Implement getTableName() method
  - [x] 4.3 Update CREATE TABLE statements to use prefixed names
  - [x] 4.4 Update all SELECT, INSERT, UPDATE, DELETE queries to use prefixed names
  - [x] 4.5 Update CREATE INDEX statements to use prefixed names

- [x] 5. Write property-based tests for PostgreSQL prefixing
  _Skills: `testing-patterns`, `postgresql`
  - [x] 5.1 Property test: Table name construction correctness
  - [x] 5.2 Property test: Query prefix consistency
  - [x] 5.3 Integration test: Create and query `tpc_`-prefixed tables

## Phase 3: Neo4j Integration

- [x] 6. Modify Graph_Store for node label prefix support
  _Skills: `typescript-expert`, `clean-code`
  - [x] 6.1 Add prefix parameter to constructor
  - [x] 6.2 Implement getLabel() method
  - [x] 6.3 Update MATCH, MERGE, CREATE, DELETE statements to use prefixed labels

- [x] 7. Modify Graph_Store for relationship type prefix support
  _Skills: `typescript-expert`, `clean-code`
  - [x] 7.1 Implement getRelationType() method
  - [x] 7.2 Update MATCH, MERGE, CREATE, DELETE statements to use prefixed types

- [x] 8. Write property-based tests for Neo4j prefixing
  _Skills: `testing-patterns`
  - [x] 8.1 Property test: Node label construction correctness
  - [x] 8.2 Property test: Relationship type construction correctness
  - [x] 8.3 Integration test: Create and query `tpc_`-prefixed nodes and relationships

## Phase 4: Query Builders

- [x] 9. Modify Cypher Query Builder for prefix support
  _Skills: `typescript-expert`, `clean-code`
  - [x] 9.1 Add prefix parameter to constructor
  - [x] 9.2 Update MATCH, MERGE, CREATE to prepend prefix to labels
  - [x] 9.3 Update relationship methods to prepend prefix to types
  - [x] 9.4 Add getPrefix() method for debugging

- [x] 10. Modify SQL Query Builder for prefix support
  _Skills: `typescript-expert`, `clean-code`
  - [x] 10.1 Add prefix parameter to constructor
  - [x] 10.2 Update SELECT, INSERT, UPDATE, DELETE to prepend prefix to table names
  - [x] 10.3 Add getPrefix() method for debugging

- [x] 11. Write property-based tests for query builders
  _Skills: `testing-patterns`
  - [x] 11.1 Property test: Cypher query prefix consistency
  - [x] 11.2 Property test: SQL query prefix consistency

## Phase 5: Integration Points

- [x] 12. Integrate Configuration_Manager with CLI
  _Skills: `typescript-expert`, `nodejs-best-practices`
  - [x] 12.1 Initialize Configuration_Manager at CLI startup
  - [x] 12.2 Pass single prefix to indexing pipeline
  - [x] 12.3 Use prefix in parse, status, and reindex commands

- [x] 13. Integrate Configuration_Manager with Query Server
  _Skills: `typescript-expert`, `nodejs-best-practices`
  - [x] 13.1 Initialize Configuration_Manager at server startup
  - [x] 13.2 Pass prefix to both Graph_Store and Vector_Store
  - [x] 13.3 Implement response prefix stripping
  - [x] 13.4 Add prefix to debug logs

- [x] 14. Integrate Configuration_Manager with MCP Server
  _Skills: `typescript-expert`, `nodejs-best-practices`
  - [x] 14.1 Use prefix in all MCP tool queries
  - [x] 14.2 Strip prefix from MCP tool responses
  - [x] 14.3 Add error handling for prefix configuration errors

## Phase 6: Error Handling & Validation

- [x] 15. Implement comprehensive error handling
  _Skills: `error-handling-patterns`, `typescript-expert`
  - [x] 15.1 Create ConfigurationError and PrefixValidationError classes
  - [x] 15.2 Implement error message generation with suggestions
  - [x] 15.3 Add startup validation with fail-fast behavior
  - [x] 15.4 Display user-friendly errors in CLI

- [x] 16. Write error handling tests
  _Skills: `testing-patterns`
  - [x] 16.1 Test invalid prefix error messages include reason and suggestion
  - [x] 16.2 Test Configuration_Error thrown at startup for invalid prefix
  - [x] 16.3 Test CLI displays errors in user-friendly format

## Phase 7: Logging & Documentation

- [x] 17. Implement logging and create documentation
  _Skills: `nodejs-best-practices`, `clean-code`
  - [x] 17.1 Log effective prefix at startup (including when using default `tpc_`)
  - [x] 17.2 Log prefix in debug-level database operation logs
  - [x] 17.3 Document `TYPOCOP_PREFIX` env var, naming rules, and examples
  - [x] 17.4 Update `.env-typocop` example with `TYPOCOP_PREFIX=tpc_`
