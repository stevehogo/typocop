/**
 * Parse worker entry (B1).
 *
 * Owns its OWN `Map<variant, Parser>` + (via `extractSymbolsWithQueries`) the
 * per-variant compiled-query cache, so a tree-sitter `Parser`/`Query`/`Tree` is
 * NEVER shared across threads and NEVER leaves this worker — only the PLAIN
 * `{ symbols, hints, contentHash }` (or a skip) crosses back.
 *
 * It replicates the historical in-process `processFile` logic verbatim:
 *   grammarVariantForFile → cached initParserForVariant → parseSourceFile →
 *   extractSymbolsWithQueries, with the structural-fallback path. Every task is
 *   wrapped in try/catch: a `ParseError`, a parser-init failure, or any
 *   unexpected throw SKIPS that one file (reported as a skip) — it NEVER kills
 *   the worker, so one bad file cannot take down the thread.
 *
 * The task logic lives in {@link runParseTask}, a pure async function that takes
 * the worker's parser cache explicitly. The `worker_threads` bootstrap at the
 * bottom only runs when this module is loaded as a Worker (it is a no-op under a
 * normal import), so the SAME `runParseTask` is exercised by the in-process pool
 * fallback and the determinism tests — guaranteeing the parallel path's per-file
 * output is byte-identical to the serial path.
 */
import { parentPort } from "node:worker_threads";
import * as path from "node:path";
import Parser from "tree-sitter";
import { fromSyntaxNode } from "./ast-node.js";
import {
  parseSourceFile,
  ParseError,
  initParserForVariant,
  grammarVariantForFile,
  type ParsedSource,
} from "./parse-file.js";
import { extractSymbolsWithQueries, extractSymbols } from "./extract-symbols.js";
import { generateSymbolId } from "./symbol-id.js";
import { sha256Hex } from "../../platform/utils/hash.js";
import type {
  ParseTask,
  ParseTaskResult,
  WorkerInbound,
} from "./parse-worker-protocol.js";

/**
 * Run ONE parse task against a worker-owned parser cache. Pure: never throws
 * (all failure modes become a `{ skipped: true, reason }` result), never touches
 * `worker_threads`. Reused by the worker bootstrap, the in-process pool fallback,
 * and the determinism tests so all three share the exact same per-file logic.
 */
export async function runParseTask(
  task: ParseTask,
  parsers: Map<string, Parser>,
): Promise<ParseTaskResult> {
  const { index, filePath, relativePath, language, size } = task;
  const variant = grammarVariantForFile(language, relativePath);

  // Cached parser per grammar variant (load/compile is the expensive part).
  let parser = parsers.get(variant);
  if (parser === undefined) {
    try {
      parser = await initParserForVariant(language, variant);
      parsers.set(variant, parser);
    } catch (err) {
      return { index, skipped: true, reason: `parser-init failed for ${variant}: ${String(err)}` };
    }
  }

  let parsed: ParsedSource;
  try {
    parsed = await parseSourceFile(filePath, language, parser, size);
  } catch (err) {
    const reason =
      err instanceof ParseError ? err.message : `unexpected parse error: ${String(err)}`;
    return { index, skipped: true, reason };
  }

  // Hash the content the parser already read (A2) — no second fs.readFile.
  const contentHash = sha256Hex(parsed.content);

  try {
    const result = extractSymbolsWithQueries(parsed.tree, relativePath, language, parser);
    if (result.symbols.length > 0) {
      return { index, symbols: result.symbols, hints: result.hints, contentHash };
    }
    // Structural fallback with deterministic IDs — lazily build the eager AST.
    const ast = fromSyntaxNode(parsed.tree.rootNode);
    const fallback = extractSymbols(ast, relativePath).map((sym) => ({
      ...sym,
      id: generateSymbolId(
        sym.location.filePath,
        sym.name,
        sym.location.startLine,
        sym.location.startColumn,
      ),
    }));
    return { index, symbols: fallback, hints: [], contentHash };
  } catch (err) {
    // Extraction blew up on a degenerate tree — skip the file, keep the worker.
    return { index, skipped: true, reason: `extraction failed: ${String(err)}` };
  }
}

/**
 * Resolve the worker entry module path for `new Worker(...)`.
 *
 * `import.meta.url` points at THIS module — `parse-worker.js` under dist (the
 * shipped runtime) — so the worker simply re-loads itself. Returned as a
 * filesystem path for `worker_threads`, which accepts both a path and a
 * `file://` URL but a plain path is the most portable.
 */
export function parseWorkerEntryPath(): string {
  return path.resolve(new URL(import.meta.url).pathname);
}

// ─── worker_threads bootstrap ─────────────────────────────────────────────────
// Only active when this module is the Worker entry (parentPort is set). Under a
// normal import (tests, the in-process fallback) parentPort is null and nothing
// below runs.
if (parentPort !== null) {
  const port = parentPort;
  // One parser cache for this worker's whole lifetime — reused across every task
  // it pulls, never shared with sibling workers.
  const parsers = new Map<string, Parser>();
  port.on("message", (msg: WorkerInbound) => {
    if (msg?.kind !== "task") return;
    void runParseTask(msg.task, parsers).then(
      (result) => port.postMessage({ kind: "result", result }),
      // runParseTask never rejects, but be defensive: surface a skip so the main
      // thread settles this index instead of waiting for the watchdog.
      (err) =>
        port.postMessage({
          kind: "result",
          result: { index: msg.task.index, skipped: true, reason: String(err) },
        }),
    );
  });
}
