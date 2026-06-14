import * as fs from "fs/promises";
import { extname } from "node:path";
import Parser from "tree-sitter";
import type { Language } from "../../core/domain.js";
import { type ASTNode, fromSyntaxNode } from "./ast-node.js";
import { MAX_FILE_SIZE, getTreeSitterBufferSize } from "../../platform/utils/limits.js";
import { collectDiagnostics } from "./diagnostic-collector.js";
import { emitDiagnostics } from "./diagnostic-formatter.js";
import { logDiagnostics } from "./diagnostic-logger.js";
import { initParser } from "./init.js";

/** Cache the TSX grammar after first load to avoid repeated dynamic imports. */
let tsxGrammar: Parser.Language | null = null;

async function loadTsxGrammar(): Promise<Parser.Language> {
  if (tsxGrammar !== null) return tsxGrammar;
  const mod = await import("tree-sitter-typescript");
  tsxGrammar = (mod.default as { tsx: Parser.Language }).tsx;
  return tsxGrammar;
}

/**
 * Initialize a parser already configured for a specific grammar VARIANT (B3).
 *
 * Grammar selection is stateless: each variant gets its own `Parser` with the
 * correct grammar set ONCE here. The tsx variant gets the tsx grammar; every
 * other variant uses the language's default grammar. Because the grammar is
 * never mutated after init, a `.tsx` file never flips the parser used for `.ts`
 * files — eliminating the sticky-TSX bug. `extractAllSymbols` keys its parser
 * cache by variant (from {@link grammarVariantForFile}) and reuses the matching
 * parser for every file of that variant.
 */
export async function initParserForVariant(
  language: Language,
  variant: string,
): Promise<Parser> {
  const parser = await initParser(language);
  if (variant === `${language}:tsx`) {
    parser.setLanguage(await loadTsxGrammar());
  }
  return parser;
}

/**
 * Grammar variant for a parsed file — distinguishes the tsx grammar from the
 * plain ts/js grammar so query compilation can be cached per variant.
 * (B2: tsx and ts are distinct tree-sitter grammars; a Query compiled against
 * one must not be run against a tree produced by the other.)
 */
export function grammarVariantForFile(language: Language, filePath: string): string {
  if (extname(filePath) === ".tsx") return `${language}:tsx`;
  return language;
}

/** Typed error for parse failures — callers can catch and skip the file */
export class ParseError extends Error {
  constructor(
    public readonly filePath: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`ParseError [${filePath}]: ${message}`);
    this.name = "ParseError";
  }
}

/** Live tree-sitter artifacts from a single parse — the query path's input. */
export interface ParsedSource {
  readonly content: string;
  readonly tree: Parser.Tree;
}

/**
 * Read and parse a source file with a SINGLE tree-sitter parse, returning the
 * live `Tree` and source `content`.
 *
 * This is the low-level entry point the query path uses so it never reparses
 * (B1). The eager `ASTNode` tree is intentionally NOT built here — callers that
 * need it (the fallback path, framework detectors) build it lazily from
 * `tree.rootNode` via `fromSyntaxNode`.
 *
 * On syntax errors: logs a warning and throws ParseError (Req 18.1, 18.2).
 * On oversized files: throws ParseError without reading content (Req 23.1).
 *
 * @param knownSize - Optional file size already collected in Phase 1
 *   ({@link FileNode.size}). When provided, the redundant `fs.stat` is skipped
 *   (B5) and the MAX_FILE_SIZE check is applied against this value instead.
 *   Callers without a known size (the `parseFile` wrapper, tests) omit it and
 *   keep the stat path.
 */
export async function parseSourceFile(
  filePath: string,
  _language: Language,
  parser: Parser,
  knownSize?: number,
): Promise<ParsedSource> {
  // Check file size before reading. Skip the redundant fs.stat when Phase 1
  // already collected the size (B5); apply the same MAX_FILE_SIZE gate.
  let size: number;
  if (knownSize !== undefined) {
    size = knownSize;
  } else {
    try {
      size = (await fs.stat(filePath)).size;
    } catch (err) {
      const msg = `Cannot stat file: ${String(err)}`;
      console.warn(`[parser] Warning: ${msg} — skipping ${filePath}`);
      throw new ParseError(filePath, msg, err);
    }
  }

  if (size > MAX_FILE_SIZE) {
    const msg = `File exceeds MAX_FILE_SIZE (${size} > ${MAX_FILE_SIZE} bytes)`;
    console.warn(`[parser] Warning: ${msg} — skipping ${filePath}`);
    throw new ParseError(filePath, msg);
  }

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    const msg = `Cannot read file: ${String(err)}`;
    console.warn(`[parser] Warning: ${msg} — skipping ${filePath}`);
    throw new ParseError(filePath, msg, err);
  }

  let tree: Parser.Tree;
  try {
    // B3: the parser handed in is already configured for its grammar variant
    // (see initParserForVariant). We never mutate its grammar here, so there is
    // nothing to restore and no cross-file grammar bleed.
    const bufferSize = getTreeSitterBufferSize(content.length);
    tree = parser.parse(content, undefined, { bufferSize });
  } catch (err) {
    const msg = `tree-sitter parse failed: ${String(err)}`;
    console.warn(`[parser] Warning: ${msg} — skipping ${filePath}`);
    throw new ParseError(filePath, msg, err);
  }

  if (tree.rootNode.hasError) {
    const diagnostics = collectDiagnostics(tree.rootNode, content, filePath);
    if (diagnostics.length > 0) {
      await logDiagnostics(diagnostics);
    }
  }

  return { content, tree };
}

/**
 * Read and parse a source file into an ASTNode tree.
 *
 * Thin compatibility wrapper over {@link parseSourceFile} for callers that
 * still want the eager `ASTNode` tree. Phase 2 no longer uses this on the
 * common path (it routes through `parseSourceFile`); kept for any remaining
 * `ASTNode`-shaped callers.
 *
 * On syntax errors: logs a warning and throws ParseError (Req 18.1, 18.2).
 * On oversized files: throws ParseError without reading content (Req 23.1).
 */
export async function parseFile(
  filePath: string,
  language: Language,
  parser: Parser,
): Promise<ASTNode> {
  const { tree } = await parseSourceFile(filePath, language, parser);
  return fromSyntaxNode(tree.rootNode);
}
