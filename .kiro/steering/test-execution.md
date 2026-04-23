---
inclusion: fileMatch
fileMatchPattern: "src/**"
---

# Test Execution Guidelines

## Running Tests

Always use `pnpm` (not npm/yarn) and run tests with minimal verbosity:

```bash
# Run all tests (use --run to avoid watch mode)
pnpm vitest --run

# Run with minimal output
pnpm vitest --run --reporter=basic

# Run specific test file
pnpm vitest --run src/parser/index.test.ts

# Run tests matching pattern
pnpm vitest --run --grep "symbol extraction"

# Stop on first failure
pnpm vitest --run --bail=1

# Run in parallel (default, adjust if needed)
pnpm vitest --run --maxWorkers=4
```

## Property-Based Tests Warning

Property-based tests using `fast-check` can take longer to run (100+ test cases per property). When running property tests:

- Use `--timeout` flag to increase timeout if needed: `pnpm vitest --run --timeout=10000`
- Run property tests separately from unit tests when debugging
- Use `fc.assert(fc.property(...), { numRuns: 10 })` for faster feedback during development
- Increase to `numRuns: 100` or more for CI/production validation

## Test Organization

Tests are co-located with source files:

```
src/
  parser/
    index.ts
    index.test.ts          # Unit tests for parser
  indexer/
    phase1-structure.ts
    phase1-structure.test.ts
tests/
  integration/
    pipeline.test.ts       # Full pipeline integration tests
    query-types.test.ts    # Query execution tests
```

## Output Management

- Use `--reporter=basic` for minimal output
- Use `--reporter=verbose` only when debugging specific failures
- Capture detailed logs to files when needed: `pnpm vitest --run > test-results.log 2>&1`
- Use `--silent` flag to suppress console.log from tests

## Performance Tips

- Run tests in parallel (default behavior)
- Use test caching: vitest caches by default
- Mock external dependencies (LadybugDB, Ollama) to speed up tests
- Skip slow integration tests during development: `test.skip()` or `--grep "^(?!.*integration)"`

## CI/CD Considerations

- Use different verbosity for local vs CI: `--reporter=basic` locally, `--reporter=json` in CI
- Capture test artifacts (coverage, reports) separately from console output
- Use `--coverage` flag to generate coverage reports
- Set appropriate timeouts for property-based tests in CI

## Common Test Commands

```bash
# Development workflow
pnpm vitest --run --reporter=basic

# Debug specific test
pnpm vitest --run --grep "resolves imports correctly"

# Run with coverage
pnpm vitest --run --coverage

# Run only unit tests (exclude integration)
pnpm vitest --run --exclude "tests/integration/**"

# Run only integration tests
pnpm vitest --run tests/integration/

# Watch mode for TDD (use sparingly)
pnpm vitest --watch src/parser/index.test.ts
```

## Test Naming Conventions

Use descriptive test names following the pattern: "should [expected behavior] when [condition]"

```typescript
describe("parseFile", () => {
  it("should extract all function symbols when parsing TypeScript", async () => {
    // ...
  });

  it("should return empty array when file is empty", async () => {
    // ...
  });

  it("should throw ParseError when file contains syntax errors", async () => {
    // ...
  });
});
```

## Debugging Failed Tests

1. Run the specific test file: `pnpm vitest --run path/to/test.ts`
2. Add `--reporter=verbose` to see full output
3. Use `console.log` or `debugger` statements (remember to remove them)
4. Check test fixtures and mock data
5. Verify external dependencies are properly mocked
