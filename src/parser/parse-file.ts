import * as fs from "fs/promises";
import { createRequire } from "node:module";
import { extname } from "node:path";
import Parser from "tree-sitter";
import type { Language } from "../types/index.js";
import { type ASTNode, fromSyntaxNode } from "./ast-node.js";
import { MAX_FILE_SIZE, getTreeSitterBufferSize } from "../utils/limits.js";
import { collectDiagnostics } from "./diagnostic-collector.js";
import { emitDiagnostics } from "./diagnostic-formatter.js";
import { logDiagnostics } from "./diagnostic-logger.js";

const require = createRequire(import.meta.url);

/** Switch the parser to the TSX grammar when the file extension is `.tsx`. */
function applyTsxGrammarIfNeeded(parser: Parser, filePath: string): void {
  if (extname(filePath) === ".tsx") {
    const tsGrammars = require("tree-sitter-typescript") as {
      tsx: Parser.Language;
    };
    parser.setLanguage(tsGrammars.tsx);
  }
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

/**
 * Read and parse a source file into an ASTNode tree.
 *
 * On syntax errors: logs a warning and throws ParseError (Req 18.1, 18.2).
 * On oversized files: throws ParseError without reading content (Req 23.1).
 */
export async function parseFile(
  filePath: string,
  _language: Language,
  parser: Parser,
): Promise<ASTNode> {
  // Check file size before reading
  let stat: { size: number };
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    const msg = `Cannot stat file: ${String(err)}`;
    console.warn(`[parser] Warning: ${msg} — skipping ${filePath}`);
    throw new ParseError(filePath, msg, err);
  }

  if (stat.size > MAX_FILE_SIZE) {
    const msg = `File exceeds MAX_FILE_SIZE (${stat.size} > ${MAX_FILE_SIZE} bytes)`;
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
    applyTsxGrammarIfNeeded(parser, filePath);
    const bufferSize = getTreeSitterBufferSize(content.length);
    tree = parser.parse(content, undefined, { bufferSize });
  } catch (err) {
    const msg = `tree-sitter parse failed: ${String(err)}`;
    console.warn(`[parser] Warning: ${msg} — skipping ${filePath}`);
    throw new ParseError(filePath, msg, err);
  }

  if (tree.rootNode.hasError) {
    const diagnostics = collectDiagnostics(tree.rootNode, content, filePath);
    await logDiagnostics(diagnostics);
  }

  return fromSyntaxNode(tree.rootNode);
}
