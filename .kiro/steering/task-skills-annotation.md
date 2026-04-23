---
inclusion: fileMatch
fileMatchPattern: ".kiro/specs/**"
---

# Task Skills Annotation

## Rule: Annotate every task in tasks.md with a `_Skills` field

When generating or updating a `tasks.md` file, each top-level task MUST include a `_Skills` line listing the relevant skills from the available skill set. Place the `_Skills` line directly under the task title, before any sub-tasks.

### Format

```markdown
- [ ] 1. Task title
  _Skills: `skill-name`, `skill-name-2`
  - [ ] 1.1 Sub-task
  - [ ] 1.2 Sub-task
```

### Skill Selection Rules

Map task content to skills using these guidelines:

| Task involves... | Include skill |
|---|---|
| Writing unit tests, property-based tests, test factories | `testing-patterns` |
| TDD red-green-refactor cycle, writing tests before code | `tdd-workflow` |
| TypeScript types, generics, strict mode, type guards | `typescript-expert` |
| Refactoring for readability, naming, single responsibility | `clean-code` |
| Error handling, retry logic, typed errors | `error-handling-patterns` |
| Architecture decisions, component design, trade-offs | `architecture` |
| Node.js async patterns, streams, performance | `nodejs-best-practices` |
| NestJS controllers, guards, interceptors, pipes | `nestjs-expert` |
| Laravel controllers, Eloquent, service providers | `laravel-expert` |
| PHP generators, SPL, modern OOP | `php-pro` |
| LadybugDB schema, indexes, constraints | `postgresql` |
| Slow queries, query plans, index optimization | `sql-optimization-patterns` |
| Vector databases, embeddings, semantic search | `vector-database-engineer` |
| Security auditing, penetration testing, hardening | `security-audit` |

### Examples

```markdown
- [ ] 1. Expand DEFAULT_IGNORE_LIST and export constants
  _Skills: `typescript-expert`, `clean-code`
  - [ ] 1.1 Add __tests__ to DEFAULT_IGNORE_LIST
  - [ ] 1.2 Export constants as ReadonlySet<string>

- [ ] 2. Write unit tests for shouldIgnorePath
  _Skills: `testing-patterns`, `tdd-workflow`
  - [ ] 2.1 Test directory segment matching
  - [ ] 2.2 Test compound extension matching

- [ ] 3. Write property-based tests
  _Skills: `testing-patterns`
  - [ ] 3.1 Property 1: directory segment ignore is total
```

### Available Skills

The full list of available skills (use exact names):

`architecture`, `clean-code`, `error-handling-patterns`, `laravel-expert`,
`nestjs-expert`, `nodejs-best-practices`, `php-pro`, `postgresql`,
`security-audit`, `sql-optimization-patterns`, `tdd-workflow`,
`testing-patterns`, `typescript-expert`, `vector-database-engineer`

### When to omit

If a task is purely mechanical (e.g. "run tests", "verify file exists"), `_Skills` may be omitted. For all implementation and test-writing tasks, it is required.
