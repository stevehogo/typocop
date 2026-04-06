# Requirements Document

## Introduction

This feature packages Typocop (Code Graph Analyzer) as a distributable CLI tool that developers can install globally via `pnpm add -g typocop` (or `npm install -g typocop`) and invoke as `typocop` from any directory. The project already has CLI command logic in `src/cli/`; this spec covers the packaging, entry point wiring, build pipeline, and distribution concerns needed to make that code installable and runnable as a standalone binary.

## Glossary

- **CLI_Entry_Point**: The compiled JavaScript file declared in `package.json` `bin` field that Node.js executes when the user runs `typocop`
- **Package**: The published npm/pnpm package named `typocop`
- **Build_Output**: The compiled JavaScript files produced by `tsc` in the `dist/` directory
- **Shebang**: The `#!/usr/bin/env node` line at the top of the CLI entry point that tells the OS to execute the file with Node.js
- **Bin_Field**: The `bin` key in `package.json` that maps CLI command names to their entry point files
- **Global_Install**: Installation via `pnpm add -g typocop` or `npm install -g typocop` that makes the command available system-wide
- **Local_Install**: Installation via `pnpm add typocop` that makes the command available via `pnpm exec typocop` or `npx typocop`
- **MCP_Entry_Point**: The compiled JavaScript file that starts the MCP server, declared in `bin` as `typocop-mcp`
- **Files_Field**: The `files` key in `package.json` that controls which files are included in the published package
- **Prepublish_Script**: A `build` script that compiles TypeScript before the package is published or packed
- **Node_Version**: The minimum Node.js version required to run the CLI, declared in `engines` field
- **Env_Flag**: The `-e, --env <path>` global option available on both `typocop` and `typocop-mcp` that loads a `.env` file before any command executes
- **Dotenv**: The `dotenv` npm package used to parse and load `.env` files into `process.env`

## Requirements

### Requirement 1: CLI Entry Point Wiring

**User Story:** As a developer, I want to run `typocop` after installing the package globally, so that I can use the CLI without specifying a full path.

#### Acceptance Criteria

1. THE Package SHALL declare a `bin` field in `package.json` mapping `"typocop"` to `"dist/cli/main.js"`
2. THE CLI_Entry_Point SHALL contain a shebang line `#!/usr/bin/env node` as its first line
3. WHEN the CLI_Entry_Point is executed, THE CLI_Entry_Point SHALL invoke `parseArgs` and `executeCLI` from `src/cli/`
4. IF `parseArgs` throws a `CLIValidationError`, THEN THE CLI_Entry_Point SHALL print the error message to stderr and exit with code 1
5. IF `executeCLI` throws an unexpected error, THEN THE CLI_Entry_Point SHALL print the error message to stderr and exit with code 1
6. WHEN a command completes successfully, THE CLI_Entry_Point SHALL exit with code 0
7. THE Package SHALL declare a `bin` field mapping `"typocop-mcp"` to `"dist/mcp/main.js"` for the MCP server entry point

### Requirement 2: Build Pipeline

**User Story:** As a developer, I want the TypeScript source to be compiled automatically before packaging, so that the published package always contains up-to-date JavaScript.

#### Acceptance Criteria

1. THE Package SHALL declare a `build` script in `package.json` that runs `tsc`
2. THE Package SHALL declare a `prepublishOnly` script in `package.json` that runs the `build` script before publishing
3. WHEN `pnpm run build` is executed, THE Build_Output SHALL be written to the `dist/` directory
4. WHEN `pnpm run build` is executed, THE Build_Output SHALL include `dist/cli/main.js` and `dist/mcp/main.js`
5. THE Package SHALL declare a `clean` script that removes the `dist/` directory

### Requirement 3: Package Metadata

**User Story:** As a developer, I want the package to have correct metadata, so that it is discoverable and installable from the npm registry.

#### Acceptance Criteria

1. THE Package SHALL declare `"name": "typocop"` in `package.json`
2. THE Package SHALL declare a `version` field following semantic versioning (MAJOR.MINOR.PATCH)
3. THE Package SHALL declare a `description` field with a non-empty string
4. THE Package SHALL declare a `license` field
5. THE Package SHALL declare an `engines` field specifying the minimum Node.js version as `">=20.0.0"`
6. THE Package SHALL declare `"type": "module"` in `package.json` to use ESM
7. THE Package SHALL declare a `repository` field pointing to the source repository

### Requirement 4: Published File Set

**User Story:** As a developer, I want only the necessary files to be included in the published package, so that the package download is minimal and does not expose source files or test artifacts.

#### Acceptance Criteria

1. THE Package SHALL declare a `files` field in `package.json` listing `["dist", "README.md"]`
2. WHEN the package is packed, THE Package SHALL include all files under `dist/`
3. WHEN the package is packed, THE Package SHALL exclude `src/`, `tests/`, `*.test.ts`, `.kiro/`, `.env`, and `node_modules/`
4. THE Package SHALL include a `.npmignore` or rely on the `files` field to exclude non-distribution files

### Requirement 5: MCP Server Entry Point

**User Story:** As a developer, I want to start the MCP server via `typocop-mcp`, so that I can connect AI editors to the query engine without writing a custom launch script.

#### Acceptance Criteria

1. THE MCP_Entry_Point SHALL contain a shebang line `#!/usr/bin/env node` as its first line
2. WHEN `typocop-mcp` is executed, THE MCP_Entry_Point SHALL start the MCP server from `src/mcp/`
3. IF the MCP server fails to start, THEN THE MCP_Entry_Point SHALL print the error message to stderr and exit with code 1
4. WHEN the MCP server starts successfully, THE MCP_Entry_Point SHALL remain running until the process is terminated

### Requirement 6: Environment Variable Configuration

**User Story:** As a developer, I want to configure database connections via environment variables, so that I can use the CLI in different environments without modifying code.

#### Acceptance Criteria

1. THE CLI_Entry_Point SHALL read `NEO4J_URI`, `NEO4J_USER`, and `NEO4J_PASSWORD` from environment variables for graph database configuration
2. THE CLI_Entry_Point SHALL read `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD` from environment variables for vector store configuration
3. THE CLI_Entry_Point SHALL read `OPENAI_API_KEY` from environment variables for embedding service configuration
4. WHERE environment variables are not set, THE CLI_Entry_Point SHALL use documented default values
5. THE Package SHALL include a `.env.example` file listing all supported environment variables with their default values
6. WHEN the Env_Flag is provided, THE CLI_Entry_Point SHALL load environment variables from the specified file via Dotenv before reading any configuration values
7. WHEN the Env_Flag is not provided, THE CLI_Entry_Point SHALL read configuration exclusively from the process environment already set at startup

### Requirement 7: Global Install Verification

**User Story:** As a developer, I want to verify the installation works correctly after a global install, so that I can confirm the tool is ready to use.

#### Acceptance Criteria

1. WHEN `typocop --version` is executed after global install, THE CLI_Entry_Point SHALL print the version string from `package.json` and exit with code 0
2. WHEN `typocop --help` is executed, THE CLI_Entry_Point SHALL print usage information listing all available commands and exit with code 0
3. WHEN `typocop parse --help` is executed, THE CLI_Entry_Point SHALL print usage information for the parse command and exit with code 0
4. WHEN an unknown command is passed, THE CLI_Entry_Point SHALL print an error message and exit with code 1

### Requirement 8: Executable Permissions

**User Story:** As a developer on Linux or macOS, I want the CLI entry point to be executable, so that the global install works without manual `chmod` steps.

#### Acceptance Criteria

1. THE Build_Output file `dist/cli/main.js` SHALL have executable permissions (`chmod +x`) set after the build step on POSIX systems
2. THE Build_Output file `dist/mcp/main.js` SHALL have executable permissions set after the build step on POSIX systems
3. THE Package SHALL declare a `postbuild` script that sets executable permissions on both entry point files

### Requirement 9: Env File Loading via `-e` Flag

**User Story:** As a developer, I want to pass a `.env` file path to `typocop` and `typocop-mcp` via a global `-e` flag, so that I can load environment-specific configuration without modifying my shell environment.

#### Acceptance Criteria

1. THE CLI_Entry_Point SHALL accept a `-e, --env <path>` global option before any subcommand
2. THE MCP_Entry_Point SHALL accept a `-e, --env <path>` global option before starting the server
3. WHEN the Env_Flag is provided, THE CLI_Entry_Point SHALL invoke Dotenv to load the specified file into `process.env` before invoking `parseArgs` or `executeCLI`
4. WHEN the Env_Flag is provided, THE MCP_Entry_Point SHALL invoke Dotenv to load the specified file into `process.env` before invoking `startMCPServer`
5. IF the path supplied to the Env_Flag does not exist on the filesystem, THEN THE CLI_Entry_Point SHALL print an error message to stderr and exit with code 1
6. IF the path supplied to the Env_Flag does not exist on the filesystem, THEN THE MCP_Entry_Point SHALL print an error message to stderr and exit with code 1
7. THE Package SHALL declare `dotenv` as a runtime dependency in `package.json`
