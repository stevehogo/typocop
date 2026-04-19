#!/usr/bin/env node
/**
 * CLI entry point dispatcher.
 *
 * Checks argv for the `obsidian` subcommand BEFORE importing anything that
 * touches tree-sitter.  The obsidian path loads a lightweight module;
 * everything else loads the full executor (which statically imports the
 * indexer pipeline → tree-sitter).
 */

// Detect obsidian subcommand from raw argv — no imports yet.
const rawArgs = process.argv.slice(2);
const subcommand = rawArgs.find((a) => !a.startsWith("-") && a !== "-e" && a !== "--env");

if (subcommand === "obsidian") {
  // Lightweight path — no tree-sitter.
  import("./obsidian-main.js").then((m) => m.runObsidianCLI(rawArgs));
} else {
  // Full path — statically imports indexer → tree-sitter.
  import("./main-full.js").then((m) => m.runFullCLI(rawArgs));
}
