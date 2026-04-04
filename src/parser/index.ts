/**
 * Public API for the parser module.
 * Re-exports all parser components.
 */

export type { Language } from "../types/index.js";
export { detectLanguage, EXTENSION_TO_LANGUAGE } from "./language.js";
export { initParser } from "./init.js";
export type { ASTNode } from "./ast-node.js";
export { parseFile, ParseError } from "./parse-file.js";
export { extractSymbols, extractSymbolsWithQueries } from "./extract-symbols.js";
export { LANGUAGE_QUERIES } from "./queries.js";
