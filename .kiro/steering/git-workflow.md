---
inclusion: manual
---

# Git Workflow

Git conventions for the Code Graph Analyzer project.

## Commit Message Format

Use conventional commit format:

```
type(scope): description

[optional body]

[optional footer]
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, no logic change)
- `refactor`: Code refactoring (no feature change)
- `test`: Adding or updating tests
- `chore`: Maintenance tasks (dependencies, build config)
- `perf`: Performance improvements

### Scopes

Use component names as scopes:

- `parser`: Tree-sitter parsing
- `indexer`: Indexing pipeline phases
- `graph`: Neo4j graph database
- `vector`: pgvector semantic search
- `query`: Query execution
- `mcp`: MCP server
- `cli`: CLI commands

### Examples

```
feat(parser): add support for Rust language

Implements tree-sitter queries for Rust symbols including:
- Functions, methods, structs, enums, traits
- Impl blocks and trait implementations
- Use statements and mod declarations

Closes #42

---

fix(indexer): resolve import paths correctly for TypeScript aliases

The symbol table now loads tsconfig.json path mappings and resolves
imports using the configured aliases (e.g., @/ -> src/).

---

test(query): add property-based tests for confidence bounds

Implements Property 10 from design-correctness.md using fast-check.
Validates that all query results have confidence in [0.0, 1.0].

---

docs(readme): update installation instructions

Add Docker Compose setup for Neo4j and PostgreSQL.

---

chore(deps): update tree-sitter to v0.21.0
```

## Branching Strategy

- `main`: Stable, deployable code
- `feature/*`: New features (e.g., `feature/rust-support`)
- `fix/*`: Bug fixes (e.g., `fix/import-resolution`)
- `refactor/*`: Code refactoring (e.g., `refactor/phase3-cleanup`)
- `test/*`: Test additions (e.g., `test/property-tests`)

### Workflow

1. Create feature branch from `main`:
   ```bash
   git checkout main
   git pull
   git checkout -b feature/rust-support
   ```

2. Make changes and commit frequently:
   ```bash
   git add src/parser/queries/rust.ts
   git commit -m "feat(parser): add Rust tree-sitter queries"
   ```

3. Push and create pull request:
   ```bash
   git push -u origin feature/rust-support
   ```

4. After review and merge, delete branch:
   ```bash
   git checkout main
   git pull
   git branch -d feature/rust-support
   ```

## Commit Frequency

- Commit logical chunks of work
- Each commit should be a complete, working change
- Don't commit broken code to `main`
- Use feature branches for work-in-progress

## What to Commit

### Always commit:
- Source code (`src/`)
- Tests (`*.test.ts`)
- Configuration files (`tsconfig.json`, `package.json`)
- Documentation (`README.md`, `.kiro/specs/`)
- Steering files (`.kiro/steering/`)

### Never commit:
- Build artifacts (`dist/`, `build/`)
- Dependencies (`node_modules/`)
- Environment files (`.env`, `.env.local`)
- IDE settings (`.vscode/`, `.idea/`)
- Log files (`*.log`)
- Database files (`*.db`, `neo4j/`)
- Temporary files (`*.tmp`, `*~`)

## .gitignore

Ensure `.gitignore` includes:

```gitignore
# Dependencies
node_modules/
pnpm-lock.yaml

# Build output
dist/
build/
*.tsbuildinfo

# Environment
.env
.env.local
.env.*.local

# Databases
neo4j/
*.db
*.sqlite

# Logs
*.log
logs/

# IDE
.vscode/
.idea/
*.swp
*.swo
*~

# OS
.DS_Store
Thumbs.db

# Test coverage
coverage/
.nyc_output/

# Temporary
*.tmp
.cache/
```

## Pull Request Guidelines

- Keep PRs focused on a single concern
- Include tests for new features
- Update documentation if needed
- Reference related issues: "Closes #42"
- Request review from at least one team member
- Ensure CI passes before merging

## Tagging Releases

Use semantic versioning for releases:

```bash
# Tag a release
git tag -a v1.0.0 -m "Release version 1.0.0"
git push origin v1.0.0

# List tags
git tag -l
```

### Version Numbers

- `v1.0.0`: Major release (breaking changes)
- `v1.1.0`: Minor release (new features, backward compatible)
- `v1.1.1`: Patch release (bug fixes)

## Security

- Never commit secrets, API keys, or passwords
- Use environment variables for configuration
- Review commits for sensitive information before pushing
- Use signed commits when possible:
  ```bash
  git config --global commit.gpgsign true
  ```

## Useful Commands

```bash
# View commit history
git log --oneline --graph --all

# Undo last commit (keep changes)
git reset --soft HEAD~1

# Amend last commit message
git commit --amend

# Interactive rebase (clean up history)
git rebase -i HEAD~3

# Stash changes temporarily
git stash
git stash pop

# View changes
git diff
git diff --staged

# Check status
git status
```
