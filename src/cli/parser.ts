import { Command, CommanderError } from "commander";
import * as fs from "fs";
import { Language } from "../types/index.js";
import { detectDirectoryLanguage } from "../parser/language.js";

export interface CLIConfig {
  sourcePath: string;
  language: Language;
  outputPath?: string;
  verbose: boolean;
}

export type CLICommand =
  | { type: "parse"; config: CLIConfig }
  | { type: "reindex"; dbPath: string }
  | { type: "status" };

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
    .action((options) => {
      if (!fs.existsSync(options.path)) {
        throw new CLIValidationError(`Source path does not exist: ${options.path}`);
      }

      let lang: Language;

      if (options.lang) {
        const candidate = options.lang.toLowerCase() as Language;
        if (!supportedLanguages.includes(candidate)) {
          throw new CLIValidationError(`Unsupported language '${options.lang}'. Supported: ${supportedLanguages.join(", ")}`);
        }
        lang = candidate;
      } else {
        const detected = detectDirectoryLanguage(options.path);
        if (!detected) {
          throw new CLIValidationError(
            `Could not auto-detect language in '${options.path}'. Use --lang to specify one explicitly.`
          );
        }
        console.error(`Auto-detected language: ${detected}`);
        lang = detected;
      }

      parsedCommand = {
        type: "parse",
        config: {
          sourcePath: options.path,
          language: lang,
          outputPath: options.out,
          verbose: options.verbose
        }
      };
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

  program.parse(rawArgs);

  if (!parsedCommand) {
    throw new CLIValidationError("Failed to parse command due to unknown intent");
  }

  return parsedCommand;
}
