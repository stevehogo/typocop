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
import { isFrameworkExtractionEnabled } from "../../platform/utils/limits.js";
import {
  extractFrameworkRecords,
  type FrameworkRecords,
} from "./frameworks/extract-framework-records.js";
import type { Symbol } from "../../core/domain.js";
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

  let baseSymbols: Symbol[];
  let baseHints: ParseTaskSuccessHints;
  try {
    const result = extractSymbolsWithQueries(parsed.tree, relativePath, language, parser);
    if (result.symbols.length > 0) {
      baseSymbols = result.symbols;
      baseHints = result.hints;
    } else {
      // Structural fallback with deterministic IDs — lazily build the eager AST.
      const ast = fromSyntaxNode(parsed.tree.rootNode);
      baseSymbols = extractSymbols(ast, relativePath).map((sym) => ({
        ...sym,
        id: generateSymbolId(
          sym.location.filePath,
          sym.name,
          sym.location.startLine,
          sym.location.startColumn,
        ),
      }));
      baseHints = [];
    }
  } catch (err) {
    // Extraction blew up on a degenerate tree — skip the file, keep the worker.
    return { index, skipped: true, reason: `extraction failed: ${String(err)}` };
  }

  // ── Wave 6 framework pass (flag-gated, per-file path/text gate) ─────────────
  // Runs over the ALREADY-PARSED tree. Read the flag in-worker (workers inherit
  // `process.env`), so this path matches the in-process path. When OFF, none of
  // the below executes and the output is byte-identical to pre-Wave-6.
  if (isFrameworkExtractionEnabled()) {
    let fw: FrameworkRecords;
    try {
      fw = await extractFrameworkRecords(parsed.tree, language, relativePath, parsed.content, filePath);
    } catch {
      // Never let the framework pass take down the worker.
      fw = { routes: [], eventSubscribers: [], symbolEnrichments: [], documentationEnrichments: [], extraSymbols: [] };
    }
    const symbols = applyFrameworkSymbols(baseSymbols, fw);
    if (fw.routes.length > 0 || fw.eventSubscribers.length > 0) {
      return {
        index,
        symbols,
        hints: baseHints,
        contentHash,
        routes: fw.routes,
        eventSubscribers: fw.eventSubscribers,
      };
    }
    return { index, symbols, hints: baseHints, contentHash };
  }

  return { index, symbols: baseSymbols, hints: baseHints, contentHash };
}

/** Hint-array type for the success result (kept local to avoid a wider import). */
type ParseTaskSuccessHints = Extract<ParseTaskResult, { hints: unknown }>["hints"];

/**
 * Fold the framework pass's extra symbols + `responseKeys` + Eloquent
 * `documentation` enrichments into the file's base symbols. Synthetic
 * (path-driven) Symbols are appended; route-handler `responseKeys` (E3) are
 * stamped onto the matching method Symbol by name; Eloquent model summaries (T6)
 * are appended to the matching class Symbol's `documentation` (NO new persisted
 * field). Pure; returns the SAME array when there is nothing to apply
 * (byte-identical output).
 */
function applyFrameworkSymbols(base: Symbol[], fw: FrameworkRecords): Symbol[] {
  if (
    fw.extraSymbols.length === 0 &&
    fw.symbolEnrichments.length === 0 &&
    fw.documentationEnrichments.length === 0
  ) {
    return base;
  }

  let enriched: Symbol[] = base;

  if (fw.symbolEnrichments.length > 0) {
    const keysByMethod = new Map<string, readonly string[]>();
    for (const e of fw.symbolEnrichments) keysByMethod.set(e.methodName, e.responseKeys);
    enriched = enriched.map((sym) => {
      const keys = sym.kind === "method" ? keysByMethod.get(sym.name) : undefined;
      return keys && keys.length > 0 ? { ...sym, responseKeys: keys } : sym;
    });
  }

  if (fw.documentationEnrichments.length > 0) {
    const docByClass = new Map<string, string>();
    for (const e of fw.documentationEnrichments) docByClass.set(e.className, e.documentation);
    enriched = enriched.map((sym) => {
      if (sym.kind !== "class") return sym;
      const doc = docByClass.get(sym.name);
      if (!doc) return sym;
      // Append to any existing documentation rather than overwrite it.
      const documentation = sym.documentation ? `${sym.documentation}\n${doc}` : doc;
      return { ...sym, documentation };
    });
  }

  return fw.extraSymbols.length > 0 ? [...enriched, ...fw.extraSymbols] : enriched;
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
