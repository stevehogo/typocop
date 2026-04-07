# Correctness Properties: Schema Prefixes

Part of the [Schema Prefixes Design](./design.md).

## Acceptance Criteria Testing Prework

### Requirement 1: Environment Configuration

1.1 WHEN the application starts, THE Configuration_Manager SHALL read `TYPOCOP_PREFIX` from environment variables.
  Classification: PROPERTY
  Test Strategy: Generate random valid prefixes, set in environment, verify Configuration_Manager reads them correctly

1.2 WHERE `TYPOCOP_PREFIX` is not set, THE Configuration_Manager SHALL default to `tpc_`.
  Classification: EXAMPLE
  Test Strategy: Unset env var, initialize manager, verify `tpc_` is used

1.3 WHEN a prefix is provided, THE Configuration_Manager SHALL validate it before accepting it.
  Classification: PROPERTY
  Test Strategy: Generate invalid prefixes, verify validation rejects them

1.4 IF a prefix is invalid, THEN THE Configuration_Manager SHALL throw a Configuration_Error.
  Classification: PROPERTY
  Test Strategy: Generate invalid prefixes, verify Configuration_Error is thrown with descriptive message

### Requirement 2: Prefix Validation

2.1 WHEN a prefix is provided, THE Prefix_Validator SHALL verify it matches `^[a-z][a-z0-9_]*$`.
  Classification: PROPERTY
  Test Strategy: Generate random strings, verify only valid patterns are accepted

2.2 IF a prefix contains uppercase letters, THEN THE Prefix_Validator SHALL reject it.
  Classification: PROPERTY
  Test Strategy: Generate prefixes with uppercase, verify rejection

2.3 IF a prefix is longer than 32 characters, THEN THE Prefix_Validator SHALL reject it.
  Classification: PROPERTY
  Test Strategy: Generate prefixes of varying lengths, verify > 32 is rejected

2.4 WHERE a prefix does not end with an underscore, THE Prefix_Validator SHALL append one automatically.
  Classification: PROPERTY
  Test Strategy: Generate valid prefixes without trailing underscore, verify underscore is appended

### Requirement 3: PostgreSQL Table Prefixing

3.1 WHEN the Vector_Store initializes, THE Vector_Store SHALL construct table names by concatenating the prefix with the base table name.
  Classification: PROPERTY
  Test Strategy: Generate random prefixes, verify table names are constructed as prefix + base_name

3.2 WHEN querying tables, THE Vector_Store SHALL use the prefixed table names in all SELECT, INSERT, UPDATE, DELETE statements.
  Classification: PROPERTY
  Test Strategy: Generate various query types, verify prefixed table names are used

### Requirement 4: Neo4j Node Label Prefixing

4.1 WHEN the Graph_Store initializes, THE Graph_Store SHALL construct node labels by concatenating the prefix with the base label name.
  Classification: PROPERTY
  Test Strategy: Generate random prefixes, verify labels are constructed as prefix + base_label

4.2 WHEN querying nodes, THE Graph_Store SHALL use the prefixed labels in all MATCH statements.
  Classification: PROPERTY
  Test Strategy: Generate MATCH queries, verify prefixed labels are used

### Requirement 5: Neo4j Relationship Type Prefixing

5.1 WHEN the Graph_Store initializes, THE Graph_Store SHALL construct relationship types by concatenating the prefix with the base type name.
  Classification: PROPERTY
  Test Strategy: Generate random prefixes, verify relationship types are constructed as prefix + base_type

5.2 WHEN querying relationships, THE Graph_Store SHALL use the prefixed types in all MATCH statements.
  Classification: PROPERTY
  Test Strategy: Generate MATCH queries, verify prefixed relationship types are used

## Correctness Properties

### Property 1: Prefix Validation Correctness

*For any* string input, the prefix validator SHALL accept only strings matching `^[a-z][a-z0-9_]*$` with length ≤ 32 characters, and SHALL automatically append an underscore if the string doesn't end with one. Empty string SHALL be accepted as-is.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4**

### Property 2: Default Prefix Resolution

*For any* environment state, when `TYPOCOP_PREFIX` is not set the effective prefix SHALL be `tpc_`.

**Validates: Requirement 1.2**

### Property 3: Table Name Construction

*For any* valid prefix and base table name, the Vector_Store SHALL construct the final table name as prefix + base name.

**Validates: Requirements 3.1, 3.2**

### Property 4: Node Label Construction

*For any* valid prefix and base node label, the Graph_Store SHALL construct the final label as prefix + label.

**Validates: Requirements 4.1, 4.2**

### Property 5: Relationship Type Construction

*For any* valid prefix and base relationship type, the Graph_Store SHALL construct the final type as prefix + type.

**Validates: Requirements 5.1, 5.2**

### Property 6: Single Prefix Propagation

*For any* valid prefix configuration, the Configuration_Manager SHALL propagate the same prefix to both Vector_Store and Graph_Store, and both stores SHALL use identical prefixes for all subsequent operations.

**Validates: Requirements 1.1, 1.3, 1.4, 6.1, 6.2, 6.3, 6.4**

### Property 7: Error Message Descriptiveness

*For any* invalid prefix, the Configuration_Manager SHALL throw a Configuration_Error with a message that includes the invalid prefix, the reason for rejection, and a suggestion for correction if possible.

**Validates: Requirements 12.1, 12.2, 12.3**

### Property 9: Query Prefix Consistency

*For any* database query constructed with a prefix, all table names (PostgreSQL) or node labels/relationship types (Neo4j) in the query SHALL be consistently prefixed with the same prefix.

**Validates: Requirements 3.2, 4.2, 5.2, 15.1, 15.2**

### Property 10: Response Prefix Stripping

*For any* query result from the Query Server or MCP Server, all node labels and relationship types SHALL have their prefix stripped before being returned to clients.

**Validates: Requirements 9.3, 17.2**

## Testing Strategy

**Unit Tests:**
- Prefix validation (valid/invalid patterns, length limits, normalization)
- Default resolution (`tpc_` when unset, `""` when explicitly empty)
- Configuration Manager initialization and propagation
- Error message generation and descriptiveness
- Query construction with prefixes
- Response prefix stripping

**Property-Based Tests:**
- Properties 1-10 above, each with 100+ iterations
- Generate random valid/invalid prefixes and verify validator behavior
- Generate random database operations and verify prefix consistency

**Integration Tests:**
- Create `tpc_`-prefixed PostgreSQL tables and verify Vector_Store queries work
- Create `tpc_`-prefixed Neo4j nodes and verify Graph_Store queries work
- Multiple instances with different prefixes in same database
