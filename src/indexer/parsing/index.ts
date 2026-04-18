/**
 * Phase 2: Symbol extraction from ASTs.
 *
 * Processes all FileNodes, parses each file, and extracts Symbol objects
 * with deterministic IDs plus raw relationship hints for Phase 3.
 *
 * Requirements: 3.2, 4.1, 4.2
 */
import type { Symbol, Language } from "../../types/index.js";
import type { ASTNode } from "../../parser/ast-node.js";
import type { FileNode } from "../structure/index.js";
import { initParser } from "../../parser/init.js";
import { parseFile, ParseError } from "../../parser/parse-file.js";
import {
  extractSymbolsWithQueries,
  extractSymbols,
  type RawRelationshipHint,
} from "../../parser/extract-symbols.js";
import Parser from "tree-sitter";
import * as path from "path";

export type { RawRelationshipHint } from "../../parser/extract-symbols.js";

/** Combined output of Phase 2 */
export interface ParsingResult {
  readonly symbols: Symbol[];
  readonly hints: RawRelationshipHint[];
  readonly skippedFiles: number;
}

// ─── Symbol ID generation ─────────────────────────────────────────────────────

export function generateSymbolId(
  filePath: string,
  name: string,
  startLine: number,
  startColumn: number,
): string {
  return `${filePath}:${name}:${startLine}:${startColumn}`;
}

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

/**
 * Phase 2 pipeline entry point.
 * Returns symbols and raw relationship hints extracted from all files.
 *
 * @param fileNodes - Files to process (paths relative to rootPath)
 * @param rootPath  - Root used to resolve paths for I/O (defaults to CWD)
 *
 * Requirements: 3.2, 4.1, 4.2
 */
export async function extractAllSymbols(
  fileNodes: FileNode[],
  rootPath: string = process.cwd(),
): Promise<ParsingResult> {
  const allSymbols: Symbol[] = [];
  const allHints: RawRelationshipHint[] = [];
  const parsers = new Map<Language, Parser>();
  let skippedFiles = 0;
  
  // Resolve root path (same logic as walkFileTree)
  const normalizedRoot = path.resolve(rootPath);

  for (const fileNode of fileNodes) {
    let parser = parsers.get(fileNode.language);
    if (!parser) {
      try {
        parser = await initParser(fileNode.language);
        parsers.set(fileNode.language, parser);
      } catch (err) {
        console.warn(
          `[phase2] Warning: failed to init parser for ${fileNode.language} — skipping ${fileNode.path}`,
          err,
        );
        skippedFiles++;
        continue;
      }
    }

    const fullPath = path.join(normalizedRoot, fileNode.path);

    let ast: ASTNode;
    try {
      ast = await parseFile(fullPath, fileNode.language, parser);
    } catch (err) {
      if (!(err instanceof ParseError)) {
        console.warn(`[phase2] Warning: unexpected error parsing ${fileNode.path}`, err);
      }
      skippedFiles++;
      continue;
    }

    const result = extractSymbolsWithQueries(ast, fileNode.path, fileNode.language, parser);

    if (result.symbols.length > 0) {
      allSymbols.push(...result.symbols);
      allHints.push(...result.hints);
    } else {
      // Fallback: structural heuristic extraction with deterministic IDs
      const fallback = extractSymbols(ast, fileNode.path).map((sym) => ({
        ...sym,
        id: generateSymbolId(
          sym.location.filePath,
          sym.name,
          sym.location.startLine,
          sym.location.startColumn,
        ),
      }));
      allSymbols.push(...fallback);
    }
  }

  return {
    symbols: deduplicateById(allSymbols),
    hints: allHints,
    skippedFiles,
  };
}
