import { Command, CommanderError } from "commander";
import * as fs from "fs";
import { Language } from "../../core/domain.js";
import type { ObsidianExportConfig } from "../../platform/config/index.js";
import { detectDirectoryLanguage } from "../../infrastructure/parsing/language.js";

export interface CLIConfig {
  sourcePath: string;
  language: Language;
  outputPath?: string;
  verbose: boolean;
  /**
   * When true, clears all existing graph data and embeddings
   * for the configured prefix before starting the indexing pipeline.
   * This enables a complete rebuild of the knowledge graph and embeddings.
   * Defaults to false for incremental/update behavior.
   */
  refresh?: boolean;
  /**
   * A4 diff-based persistence. When true (the DEFAULT), the indexer does a delta
   * write — only changed+added files are re-parsed/re-embedded/re-inserted and
   * removed+changed file scopes are deleted; the resulting graph is identical to
   * a full index of the same tree. When false (`--full`), every file is
   * re-parsed and the graph is rewritten wholesale (today's behavior). `--full`
   * implies a full INSERT and is the safe fall-back if a delta run looks wrong.
   * Optional in the type (omitted === incremental) so callers/tests that build a
   * config literal need not set it; `parseArgs` always sets it explicitly.
   */
  incremental?: boolean;
  /**
   * Source task #7 (`--pdg`). **Default `false`.** Opt into per-function PDG +
   * interprocedural taint analysis (persists BasicBlock/TaintFinding nodes +
   * PDG/taint edges; OFF ⇒ baseline indexing is byte-identical).
   */
  pdg?: boolean;
}

export type CLICommand =
  | { type: "parse"; config: CLIConfig }
  | { type: "reindex"; dbPath: string }
  | { type: "status" }
  | { type: "obsidian"; config: ObsidianExportConfig }
  | { type: "hf" }
  | { type: "ollama"; url?: string }
  | { type: "watch"; config: CLIConfig }
  | { type: "augment"; pattern: string }
  | { type: "setup"; settingsPath?: string }
  | { type: "stop-server" }
  | { type: "check-recursion"; sourcePath: string; json: boolean; includeVendor: boolean };

const supportedLanguages: Language[] = [
  "php", "typescript", "javascript", "python", "java",
  "go", "rust", "c", "cpp", "csharp", "ruby", "swift"
];

export class CLIValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CLIValidationError";
  }
}

/**
 * Resolve the target language for a path-based command (`parse`/`watch`):
 * honour an explicit `--lang` (validated against {@link supportedLanguages}) or
 * auto-detect from the directory. Throws {@link CLIValidationError} on an
 * unsupported/undetectable language. Shared so `watch` reuses `parse`'s exact
 * path/lang validation.
 */
function resolveLanguageForPath(sourcePath: string, langOption?: string): Language {
  if (langOption) {
    const candidate = langOption.toLowerCase() as Language;
    if (!supportedLanguages.includes(candidate)) {
      throw new CLIValidationError(`Unsupported language '${langOption}'. Supported: ${supportedLanguages.join(", ")}`);
    }
    return candidate;
  }
  const detected = detectDirectoryLanguage(sourcePath);
  if (!detected) {
    throw new CLIValidationError(
      `Could not auto-detect language in '${sourcePath}'. Use --lang to specify one explicitly.`
    );
  }
  console.error(`Auto-detected language: ${detected}`);
  return detected;
}

export function parseArgs(rawArgs: string[]): CLICommand {
  const program = new Command();
  let parsedCommand: CLICommand | null = null;
  
  program
    .name("typocop")
    .description("Code Graph Analyzer \u2014 precomputed relational intelligence for source code")
    .version("0.1.0")
    .exitOverride();

  program
    .command("parse")
    .description("Parse source code and build knowledge graph")
    .requiredOption("-p, --path <path>", "Source directory path to parse")
    .option("-l, --lang <language>", "Programming language (auto-detected if omitted)")
    .option("-o, --out <path>", "Output database path")
    .option("-v, --verbose", "Enable verbose logging", false)
    .option("-r, --refresh", "Clear and rebuild all graph and embeddings data", false)
    .option("--incremental", "Diff-based delta write: re-index only changed/added files (default)", true)
    .option("--full", "Full re-index: re-parse every file and rewrite the graph wholesale")
    .option("--pdg", "Opt-in: build per-function PDG + interprocedural taint analysis (off by default)", false)
    .action((options) => {
      if (!fs.existsSync(options.path)) {
        throw new CLIValidationError(`Source path does not exist: ${options.path}`);
      }

      const lang = resolveLanguageForPath(options.path, options.lang);

      // `--full` forces a wholesale re-index; otherwise incremental (default).
      // `--refresh` (clear-then-rebuild) is inherently a full write, so it also
      // disables the delta path.
      const incremental = options.full ? false : !options.refresh;

      parsedCommand = {
        type: "parse",
        config: {
          sourcePath: options.path,
          language: lang,
          outputPath: options.out,
          verbose: options.verbose,
          refresh: options.refresh,
          incremental,
          pdg: options.pdg,
        }
      };
    });

  program
    .command("watch")
    .description("Watch a source tree and incrementally re-index on change (Ctrl+C to stop)")
    .requiredOption("-p, --path <path>", "Source directory path to watch")
    .option("-l, --lang <language>", "Programming language (auto-detected if omitted)")
    .option("-v, --verbose", "Enable verbose logging", false)
    .action((options) => {
      if (!fs.existsSync(options.path)) {
        throw new CLIValidationError(`Source path does not exist: ${options.path}`);
      }

      const lang = resolveLanguageForPath(options.path, options.lang);

      parsedCommand = {
        type: "watch",
        config: {
          sourcePath: options.path,
          language: lang,
          verbose: options.verbose,
          // Watch always drives delta re-indexing.
          incremental: true,
        },
      };
    });

  program
    .command("augment")
    .description("Emit graph context for a search pattern to stderr (used by the Claude Code hook)")
    .argument("[pattern...]", "Search pattern to augment (e.g. a symbol name)")
    .action((patternParts: string[]) => {
      // commander collects the variadic positional; join so a multi-word
      // pattern survives. `augment -- <pattern>` (the hook's form) drops `--`.
      const pattern = (patternParts ?? []).join(" ").trim();
      parsedCommand = { type: "augment", pattern };
    });

  program
    .command("setup")
    .description("Install the typocop auto-augment hook into a Claude Code settings.json")
    .option("-s, --settings <path>", "Path to the settings.json to merge into (default: ./.claude/settings.json)")
    .action((options) => {
      parsedCommand = { type: "setup", settingsPath: options.settings };
    });

  program
    .command("reindex")
    .description("Re-run the indexing pipeline against an existing database path")
    .requiredOption("-d, --db <path>", "Path to the existing database")
    .action((options) => {
      if (!fs.existsSync(options.db)) {
        throw new CLIValidationError(`Database path does not exist: ${options.db}`);
      }
      parsedCommand = {
        type: "reindex",
        dbPath: options.db
      };
    });

  program
    .command("status")
    .description("Report the current state of the knowledge graph")
    .action(() => {
      parsedCommand = {
        type: "status"
      };
    });

  program
    .command("stop-server")
    .description("Gracefully stop the running LadybugDB connection server (the one this prefix's discovery file points at)")
    .action(() => {
      parsedCommand = { type: "stop-server" };
    });

  program
    .command("check-recursion")
    .description("Report self-shadowing recursion (this.X()/$this->X() that recurses into itself instead of super / a different X). Exits 1 if any found.")
    .requiredOption("-p, --path <path>", "Source directory path to scan")
    .option("--json", "Emit findings as JSON", false)
    .option("--include-vendor", "Also scan vendor/ (lets signal A resolve framework base classes; slow)", false)
    .action((options) => {
      if (!fs.existsSync(options.path)) {
        throw new CLIValidationError(`Source path does not exist: ${options.path}`);
      }
      parsedCommand = { type: "check-recursion", sourcePath: options.path, json: options.json, includeVendor: options.includeVendor };
    });

  program
    .command("obsidian")
    .description("Export the knowledge graph as an Obsidian-compatible markdown vault")
    .option("-o, --out <path>", "Output directory for the vault", "./.typocop-obsidian")
    .option("-v, --verbose", "Enable verbose logging", false)
    .action((options) => {
      parsedCommand = {
        type: "obsidian",
        config: {
          outputPath: options.out,
          verbose: options.verbose,
        },
      };
    });

  program
    .command("hf")
    .description("Configure HuggingFace embeddings provider and download model for caching")
    .action(() => {
      parsedCommand = {
        type: "hf"
      };
    });

  program
    .command("ollama")
    .description("Configure Ollama embeddings provider")
    .option("-u, --url <url>", "Ollama server URL", "http://localhost:11434")
    .action((options) => {
      parsedCommand = {
        type: "ollama",
        url: options.url
      };
    });

  program.parse(rawArgs);

  if (!parsedCommand) {
    throw new CLIValidationError("Failed to parse command due to unknown intent");
  }

  return parsedCommand;
}
