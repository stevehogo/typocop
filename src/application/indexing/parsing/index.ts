/**
 * Phase 2: Symbol extraction from ASTs.
 *
 * Processes all FileNodes, parses each file, and extracts Symbol objects
 * with deterministic IDs plus raw relationship hints for Phase 3.
 *
 * Requirements: 3.2, 4.1, 4.2
 */
import type { Symbol } from "../../../core/domain.js";
import type { FileNode } from "../structure/index.js";
import { fromSyntaxNode } from "../../../infrastructure/parsing/ast-node.js";
import {
  parseSourceFile,
  ParseError,
  initParserForVariant,
  grammarVariantForFile,
  type ParsedSource,
} from "../../../infrastructure/parsing/parse-file.js";
import {
  extractSymbolsWithQueries,
  extractSymbols,
  type RawRelationshipHint,
} from "../../../infrastructure/parsing/extract-symbols.js";
import Parser from "tree-sitter";
import * as path from "path";
import { PARSE_CONCURRENCY } from "../../../platform/utils/limits.js";

export type { RawRelationshipHint } from "../../../infrastructure/parsing/extract-symbols.js";

/** Combined output of Phase 2 */
export interface ParsingResult {
  readonly symbols: Symbol[];
  readonly hints: RawRelationshipHint[];
  readonly skippedFiles: number;
}

/**
 * Options for {@link extractAllSymbols} (B5/B6).
 *
 * @property concurrency - Size of the bounded parsing worker pool. Defaults to
 *   {@link PARSE_CONCURRENCY}.
 * @property onProgress  - Completion hook invoked exactly ONCE per file as it
 *   settles (including skipped files), so `done` always reaches `total`. This is
 *   the SHARED per-file completion point for both the progress renderer (PR5)
 *   and the metrics layer — wire observation here rather than instrumenting the
 *   loop twice. `done` is an order-independent shared-counter bump under
 *   concurrency; `currentPath` is the file that just settled.
 */
export interface ExtractAllSymbolsOptions {
  readonly concurrency?: number;
  readonly onProgress?: (done: number, total: number, currentPath?: string) => void;
}

// ─── Symbol ID generation ─────────────────────────────────────────────────────

/**
 * Canonical symbol-ID generator (B4). Re-exported from the infrastructure layer
 * so this application module and existing importers keep resolving it, while the
 * query path (also in infrastructure) shares the SAME implementation without a
 * layering violation. Both paths now emit column-inclusive, comparable IDs.
 */
export { generateSymbolId } from "../../../infrastructure/parsing/symbol-id.js";
import { generateSymbolId } from "../../../infrastructure/parsing/symbol-id.js";

// ─── Deduplication ────────────────────────────────────────────────────────────

function deduplicateById(symbols: Symbol[]): Symbol[] {
  const seen = new Set<string>();
  const result: Symbol[] = [];
  for (const sym of symbols) {
    if (!seen.has(sym.id)) {
      seen.add(sym.id);
      result.push(sym);
    }
  }
  return result;
}

// ─── Phase 2 entry point ──────────────────────────────────────────────────────

/** Per-file extraction output collected into an original-position slot. */
interface FileSlot {
  symbols: Symbol[];
  hints: RawRelationshipHint[];
}

/**
 * Process a single file with a worker-owned parser cache.
 *
 * The worker's `parsers` map is NEVER shared with another concurrent slot, so a
 * tree-sitter `Parser` is never used by two in-flight parses at once (Risk
 * Notes). Parsers are still reused WITHIN a slot across files of the same
 * variant. Returns null when the file is skipped (parser-init failure or
 * ParseError); the caller bumps `skippedFiles`.
 */
async function processFile(
  fileNode: FileNode,
  relativeBase: string,
  parsers: Map<string, Parser>,
): Promise<FileSlot | null> {
  const variant = grammarVariantForFile(fileNode.language, fileNode.path);
  let parser = parsers.get(variant);
  if (!parser) {
    try {
      parser = await initParserForVariant(fileNode.language, variant);
      parsers.set(variant, parser);
    } catch (err) {
      console.warn(
        `[phase2] Warning: failed to init parser for ${variant} — skipping ${fileNode.path}`,
        err,
      );
      return null;
    }
  }

  const fullPath = path.resolve(relativeBase, fileNode.path);

  // Single parse — the query path queries this live tree directly (B1). The
  // Phase 1 size is threaded through so parseSourceFile skips the redundant
  // fs.stat (B5).
  let parsed: ParsedSource;
  try {
    parsed = await parseSourceFile(fullPath, fileNode.language, parser, fileNode.size);
  } catch (err) {
    if (!(err instanceof ParseError)) {
      console.warn(`[phase2] Warning: unexpected error parsing ${fileNode.path}`, err);
    }
    return null;
  }

  const result = extractSymbolsWithQueries(parsed.tree, fileNode.path, fileNode.language, parser);

  if (result.symbols.length > 0) {
    return { symbols: result.symbols, hints: result.hints };
  }

  // Fallback: structural heuristic extraction with deterministic IDs. Build the
  // eager ASTNode lazily, only here (never on the common path).
  const ast = fromSyntaxNode(parsed.tree.rootNode);
  const fallback = extractSymbols(ast, fileNode.path).map((sym) => ({
    ...sym,
    id: generateSymbolId(
      sym.location.filePath,
      sym.name,
      sym.location.startLine,
      sym.location.startColumn,
    ),
  }));
  return { symbols: fallback, hints: [] };
}

/**
 * Phase 2 pipeline entry point.
 * Returns symbols and raw relationship hints extracted from all files.
 *
 * Files are processed with a bounded-concurrency worker pool (B5). Each worker
 * owns its OWN `Map<variant, Parser>` so a tree-sitter `Parser` is never shared
 * across concurrent parses, while parsers are still reused within a worker.
 *
 * DETERMINISM: each file's output is collected into a slot indexed by its
 * ORIGINAL position in `fileNodes`, then flattened in original order before
 * deduplication. Completion order never leaks into the returned arrays, so the
 * output is byte-for-byte identical to the serial version.
 *
 * @param fileNodes - Files to process (paths relative to rootPath)
 * @param rootPath  - Root used to resolve paths for I/O (defaults to CWD)
 * @param options   - Optional concurrency knob and per-file completion hook (B6)
 *
 * Requirements: 3.2, 4.1, 4.2
 */
export async function extractAllSymbols(
  fileNodes: FileNode[],
  rootPath: string = process.cwd(),
  options: ExtractAllSymbolsOptions = {},
): Promise<ParsingResult> {
  const total = fileNodes.length;
  const concurrency = Math.max(1, options.concurrency ?? PARSE_CONCURRENCY);
  const onProgress = options.onProgress;

  // Compute the same relativeBase as walkFileTree so paths resolve correctly
  const normalizedRoot = path.resolve(rootPath);
  const cwd = process.cwd();
  const relativeBase = normalizedRoot.startsWith(cwd + path.sep) || normalizedRoot === cwd
    ? cwd
    : normalizedRoot;

  // One slot per original position preserves deterministic ordering regardless
  // of which worker finishes first.
  const slots: (FileSlot | null)[] = new Array(total).fill(null);
  let skippedFiles = 0;
  // Shared, order-independent completion counter (B6). Bumped as each task
  // settles; `done` ends exactly at `total`.
  let done = 0;

  let nextIndex = 0;

  // A worker pulls file indices from the shared counter until exhausted, using
  // its OWN parser cache — never shared with sibling workers (Risk Notes).
  async function worker(): Promise<void> {
    const parsers = new Map<string, Parser>();
    for (;;) {
      const i = nextIndex++;
      if (i >= total) return;
      const fileNode = fileNodes[i];
      const slot = await processFile(fileNode, relativeBase, parsers);
      if (slot === null) {
        skippedFiles++;
      } else {
        slots[i] = slot;
      }
      // Per-file completion point — shared by progress + metrics (B6). Counts
      // skipped files too, so `done` always reaches `total`.
      done++;
      onProgress?.(done, total, fileNode.path);
    }
  }

  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(concurrency, total); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // Flatten in ORIGINAL order — completion order never affects output.
  const allSymbols: Symbol[] = [];
  const allHints: RawRelationshipHint[] = [];
  for (const slot of slots) {
    if (slot === null) continue;
    allSymbols.push(...slot.symbols);
    allHints.push(...slot.hints);
  }

  return {
    symbols: deduplicateById(allSymbols),
    hints: allHints,
    skippedFiles,
  };
}
