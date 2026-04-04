/**
 * Phase 2: Symbol extraction from ASTs.
 *
 * Processes all FileNodes, parses each file, and extracts Symbol objects
 * with deterministic, globally-unique IDs.
 *
 * Requirements: 3.2, 4.1, 4.2
 */
import type { Symbol, Language } from "../../types/index.js";
import type { ASTNode } from "../../parser/ast-node.js";
import type { FileNode } from "../structure/index.js";
import { initParser } from "../../parser/init.js";
import { parseFile, ParseError } from "../../parser/parse-file.js";
import { extractSymbolsWithQueries, extractSymbols } from "../../parser/extract-symbols.js";
import Parser from "tree-sitter";

// ─── Symbol ID generation ─────────────────────────────────────────────────────

/**
 * Generate a deterministic, globally-unique symbol ID.
 * Format: `<filePath>:<name>:<startLine>:<startColumn>`
 *
 * This is unique because no two symbols in the same file can share
 * the same name at the same position, and filePath distinguishes files.
 */
export function generateSymbolId(
  filePath: string,
  name: string,
  startLine: number,
  startColumn: number,
): string {
  return `${filePath}:${name}:${startLine}:${startColumn}`;
}

// ─── extractSymbolsFromAST ────────────────────────────────────────────────────

/**
 * Recursively walk an ASTNode tree and extract all Symbol objects.
 * Delegates to the parser's extractSymbols for structural heuristics.
 *
 * This is a thin wrapper that ensures IDs are deterministic (not random UUIDs).
 */
export function extractSymbolsFromAST(
  ast: ASTNode,
  filePath: string,
  language: Language,
  parser: Parser,
): Symbol[] {
  // Use query-based extraction when available (more accurate, deterministic IDs)
  const raw = extractSymbolsWithQueries(ast, filePath, language, parser);

  if (raw.length > 0) {
    return deduplicateById(raw);
  }

  // Fallback: structural heuristic extraction — rewrite IDs to be deterministic
  const fallback = extractSymbols(ast, filePath);
  const withDeterministicIds = fallback.map((sym) => ({
    ...sym,
    id: generateSymbolId(
      sym.location.filePath,
      sym.name,
      sym.location.startLine,
      sym.location.startColumn,
    ),
  }));

  return deduplicateById(withDeterministicIds);
}

// ─── Deduplication ────────────────────────────────────────────────────────────

/**
 * Remove duplicate symbols by ID, keeping the first occurrence.
 * Guarantees the output has no duplicate IDs (Req 4.1, 4.3).
 */
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

// ─── extractAllSymbols ────────────────────────────────────────────────────────

/**
 * Phase 2 pipeline entry point.
 *
 * Processes all FileNodes, initialises language parsers on demand,
 * parses each file, and extracts symbols with deterministic unique IDs.
 *
 * Preconditions:  fileNodes contains valid file paths
 * Postconditions: returns all extractable symbols with unique IDs
 * Loop Invariant: allSymbols contains symbols from all processed files so far
 *
 * Requirements: 3.2, 4.1, 4.2
 */
export async function extractAllSymbols(fileNodes: FileNode[]): Promise<Symbol[]> {
  const allSymbols: Symbol[] = [];
  const parsers = new Map<Language, Parser>();

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
        continue;
      }
    }

    let ast: ASTNode;
    try {
      ast = await parseFile(fileNode.path, fileNode.language, parser);
    } catch (err) {
      if (err instanceof ParseError) {
        // Already logged by parseFile — just skip
      } else {
        console.warn(`[phase2] Warning: unexpected error parsing ${fileNode.path}`, err);
      }
      continue;
    }

    const symbols = extractSymbolsFromAST(ast, fileNode.path, fileNode.language, parser);
    allSymbols.push(...symbols);
  }

  // Final deduplication across all files (handles edge cases from parallel paths)
  return deduplicateById(allSymbols);
}
