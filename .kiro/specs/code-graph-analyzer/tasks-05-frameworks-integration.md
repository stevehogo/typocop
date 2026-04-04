# Tasks 23–24: Framework Parsers & Validation

Part of the [Implementation Plan](./tasks.md).

## Tasks

- [ ] 23. Implement framework-specific parsing
  - [x] 23.0 Implement Magento 2 parser
    - _Skills: `php-pro`, `typescript-expert`_
    - Parse webapi.xml to extract REST and GraphQL endpoint definitions (route → interface method mapping)
    - Extract Controller/Action classes from Controller/ directories (execute() method as entry point)
    - Parse Model/ResourceModel/Collection pattern (Model, ResourceModel, Collection class hierarchy)
    - Detect Repository interfaces and implementations (e.g., CustomerRepositoryInterface → CustomerRepository)
    - Detect Plugin (interceptor) before/after/around methods and their subject classes
    - Parse Event dispatch (eventManager->dispatch) and Observer registrations (events.xml)
    - Parse di.xml for dependency injection preferences and virtual types
    - Set tracingLevel to Full
    - _Requirements: 14.1, 14.9_

  - [x] 23.1 Implement NestJS parser
    - _Skills: `nestjs-expert`, `typescript-expert`_
    - Extract route decorators (@Get, @Post, etc.)
    - Parse dependency injection patterns
    - Extract Prisma and TypeORM model definitions
    - Set tracingLevel to Full
    - _Requirements: 14.2, 14.9_

  - [x] 23.2 Implement Laravel parser
    - _Skills: `laravel-expert`, `php-pro`_
    - Extract route definitions from routes files
    - Parse Eloquent model definitions
    - Extract controller methods
    - Set tracingLevel to Full
    - _Requirements: 14.3, 14.9_

  - [x] 23.3 Implement Express and Fastify parsers
    - _Skills: `nodejs-best-practices`, `typescript-expert`_
    - Extract route handlers (app.get, app.post, etc.)
    - Parse middleware chains
    - Extract Prisma, TypeORM, and Mongoose integrations
    - Set tracingLevel to Partial
    - _Requirements: 14.4, 14.5, 14.10_

  - [x] 23.4 Implement Spring Boot parser
    - _Skills: `typescript-expert`, `clean-code`_
    - Extract REST controller annotations (@GetMapping, @PostMapping, etc.)
    - Parse JPA entities and Hibernate models
    - Set tracingLevel to Partial
    - _Requirements: 14.6, 14.10_

  - [x] 23.5 Implement FastAPI and Django parsers
    - _Skills: `typescript-expert`, `clean-code`_
    - Extract FastAPI route decorators and SQLAlchemy models
    - Extract Django URL patterns and Django ORM models
    - Set tracingLevel to Partial
    - _Requirements: 14.7, 14.8, 14.10_

- [ ] 24. Implement framework support validation
  - [ ] 24.1 Implement FrameworkSupport validation rules
    - _Skills: `typescript-expert`, `clean-code`_
    - Enforce that at least one of apiEndpoints, controllers, or dbModels is true
    - Enforce that supportedORMs is non-empty when dbModels is true
    - Enforce that tracingLevel "full" requires all three capabilities to be true
    - Enforce that tracingLevel "partial" requires at least one but not all capabilities to be true
    - _Requirements: 25.1, 25.2, 25.3, 25.4_

  - [ ]* 24.2 Write property test for framework support invariant
    - _Skills: `testing-patterns`, `tdd-workflow`_
    - **Property 21: Framework Support Invariant** - Verify full tracing requires all three capabilities, dbModels requires non-empty ORMs, and at least one capability is always enabled
    - **Validates: Requirements 25.1, 25.2, 25.3, 25.4**
