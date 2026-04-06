# Tasks 25–29: MCP Server, Security & Integration

Part of the [Implementation Plan](./tasks.md).

## Tasks

- [x] 25. Implement MCP server
  - [x] 25.1 Create MCP server and protocol handling
    - _Skills: `typescript-expert`, `error-handling-patterns`_
    - Define MCPRequest and MCPResponse structures
    - Implement handleMCPRequest function
    - Add request format validation and error responses for malformed requests
    - Maintain connection state
    - _Requirements: 15.3, 15.4, 15.7_

  - [x] 25.2 Implement MCP tool and prompt registration
    - _Skills: `typescript-expert`, `clean-code`_
    - Implement registerTools for get_symbol_context, find_dependents, trace_data_flow, impact_analysis
    - Implement registerPrompts function
    - Forward valid requests to Query_Server
    - Include human-readable `summary` field in every MCPToolResponse
    - _Requirements: 15.1, 15.2, 15.5, 15.6, 15.8_

  - [x] 25.3 Implement MCP authentication
    - _Skills: `security-audit`, `typescript-expert`_
    - Add token-based authentication for MCP connections
    - Validate authentication tokens on each request
    - _Requirements: 22.5_

- [x] 26. Implement security and input validation
  - [x] 26.1 Implement query sanitization
    - _Skills: `security-audit`, `typescript-expert`_
    - Implement sanitize function for natural language queries
    - Detect and remove malicious patterns before graph database execution
    - _Requirements: 22.3_

  - [x] 26.2 Implement path validation
    - _Skills: `security-audit`, `typescript-expert`_
    - Implement isValidPath function
    - Detect and reject directory traversal patterns (../, etc.)
    - _Requirements: 22.4_

  - [x] 26.3 Implement resource limits
    - _Skills: `typescript-expert`, `nodejs-best-practices`_
    - Enforce maximum file size, graph size, and query timeout limits
    - _Requirements: 23.1, 23.2, 23.3_

  - [ ]* 26.4 Write property tests for security
    - _Skills: `testing-patterns`, `tdd-workflow`_
    - **Property 19: Input Sanitization** - Verify sanitized queries contain no malicious patterns
    - **Property 20: Path Validation** - Verify validated paths contain no traversal patterns
    - **Validates: Requirements 22.3, 22.4**

- [x] 27. Implement privacy and embedding handling
  - [x] 27.1 Ensure local-only code processing
    - _Skills: `security-audit`, `typescript-expert`_
    - Verify all parsing and indexing happens locally
    - Ensure no full code is sent to external services
    - When using embedding API, send only symbol signatures
    - _Requirements: 22.1, 22.2_

- [x] 28. Integration and end-to-end wiring
  - [x] 28.1 Wire CLI to indexing pipeline
    - _Skills: `typescript-expert`, `architecture`_
    - Connect parse, reindex, and status commands to Phase 1-6 execution
    - Wire indexing output to graph database and vector store
    - _Requirements: 1.1, 1.6, 1.7, 3.8_

  - [x] 28.2 Wire query server to databases
    - _Skills: `typescript-expert`, `architecture`_
    - Connect query server to graph database and vector store
    - Implement combined query execution for all five query types
    - _Requirements: 9.3_

  - [x] 28.3 Wire MCP server to query server
    - _Skills: `typescript-expert`, `clean-code`_
    - Connect MCP server to query server for request forwarding
    - _Requirements: 15.5_

  - [ ]* 28.4 Write integration tests
    - _Skills: `testing-patterns`, `tdd-workflow`_
    - Test full indexing pipeline on sample TypeScript, PHP, and JavaScript projects
    - Test all five query types against a pre-indexed graph
    - Test MCP integration with mock editor clients including summary field
    - Test Magento 2 sample: webapi.xml, Controller/Action, Model/ResourceModel/Collection, Repository, Plugin, Event/Observer
    - Test NestJS and Laravel framework-specific parsing
    - Test reindex and status CLI commands against an existing database
    - Verify 90%+ confidence on production queries
    - _Requirements: All requirements_

- [x] 29. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
