/**
 * Bootstrap — the single env/argv loader shared by the app composition roots
 * (TARGET-ARCHITECTURE §5.4). De-duplicates the `-e/--env` + `.env-typocop` +
 * dotenv handling the CLI and MCP entry points had copied, and centralises the
 * `ARG_TO_ENV` override mapping the ladybug-server uses.
 *
 * Depends only on node builtins + dotenv — never on a higher layer. Behaviour
 * that differs per caller is exposed via options so each entry point keeps its
 * exact prior semantics.
 */
import { existsSync } from "node:fs";

const DEFAULT_ENV_FILE = ".env-typocop";

export interface LoadEnvOptions {
  /**
   * Stop scanning at the first `-e/--env` (MCP server's historical behaviour)
   * instead of letting the last occurrence win (the CLI's). Default: false.
   */
  readonly firstMatchWins?: boolean;
  /** Pass dotenv's `quiet` flag (MCP server). Default: false. */
  readonly quiet?: boolean;
  /**
   * Return `argv` with the `-e/--env` flag and its value removed — the CLI
   * feeds the remainder to its argument parser. Default: false.
   */
  readonly stripEnvFlag?: boolean;
  /**
   * Cleanup awaited before `process.exit(1)` when an *explicitly* requested env
   * file is missing (the CLI drains its DB pools here). Default: none.
   */
  readonly onMissingExplicitEnv?: () => void | Promise<void>;
}

export interface LoadEnvResult {
  /**
   * `argv` with the `-e/--env` pair removed when `stripEnvFlag` is set;
   * otherwise a copy of the input.
   */
  readonly argv: string[];
}

/**
 * Resolve the env file from `argv` (explicit `-e/--env`, else `.env-typocop`)
 * and load it via dotenv. Exits the process with code 1 if an explicitly
 * requested file is missing; a missing default file is ignored silently.
 */
export async function loadEnv(
  argv: readonly string[],
  options: LoadEnvOptions = {},
): Promise<LoadEnvResult> {
  let envPath: string | undefined;
  let envExplicit = false;
  const remaining: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === "-e" || argv[i] === "--env") && i + 1 < argv.length) {
      envPath = argv[++i];
      envExplicit = true;
      if (options.firstMatchWins) break;
    } else {
      remaining.push(argv[i]);
    }
  }

  if (!envExplicit) {
    envPath = DEFAULT_ENV_FILE;
  }

  if (envPath !== undefined) {
    if (!existsSync(envPath)) {
      if (envExplicit) {
        process.stderr.write(`Error: env file not found: ${envPath}\n`);
        await options.onMissingExplicitEnv?.();
        process.exit(1);
      }
      // default file missing is fine — skip silently
    } else {
      const { config } = await import("dotenv");
      config(options.quiet ? { path: envPath, quiet: true } : { path: envPath });
    }
  }

  return { argv: options.stripEnvFlag ? remaining : [...argv] };
}

/**
 * Map recognised CLI flags to environment variables (the ladybug-server's
 * `--db-path`/`--prefix`/… overrides). Each recognised flag consumes the
 * argument that follows it.
 */
export function applyArgEnvOverrides(
  argv: readonly string[],
  argToEnv: Readonly<Record<string, string>>,
): void {
  for (let i = 0; i < argv.length; i++) {
    const envVar = argToEnv[argv[i]];
    if (!envVar) continue;
    const value = argv[i + 1];
    if (value) {
      process.env[envVar] = value;
      i++;
    }
  }
}
