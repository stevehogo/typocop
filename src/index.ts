#!/usr/bin/env node

import { parseArgs, executeCLI } from "./apps/cli/index.js";

async function main() {
  try {
    const command = parseArgs(process.argv);
    await executeCLI(command);
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
}

if (process.argv[1].endsWith("typocop") || process.argv[1].endsWith("index.js")) {
  main();
}
