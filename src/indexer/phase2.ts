import type { Symbol, Language } from "../types/index.js";
import type { FileNode } from "./phase1.js";
import { initParser, parseFile, extractSymbols as extractSymbolsNode } from "../parser/index.js";
import Parser from "tree-sitter";

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
        console.warn(`Failed to initialize parser for language ${fileNode.language}:`, err);
        continue;
      }
    }

    const ast = await parseFile(parser, fileNode.path);
    if (!ast) continue; // skip unparseable files

    const symbols = extractSymbolsNode(ast, fileNode.path);
    fileNode.symbols = symbols; // Link the symbols back to the file node
    allSymbols.push(...symbols);
  }

  return allSymbols;
}
