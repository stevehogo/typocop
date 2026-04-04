// Phase 6: Keyword extraction and index building for symbols

import type { Symbol } from "../../types/index.js";

/** Common stop words to filter from keyword extraction */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "in", "to", "for",
  "is", "it", "on", "at", "by", "be", "as", "do", "if",
  "get", "set", "new", "this", "that", "with", "from",
]);

/**
 * Splits a camelCase, PascalCase, or snake_case identifier into words.
 */
function splitIdentifier(name: string): string[] {
  // Handle snake_case and kebab-case first
  const withSpaces = name
    .replace(/_+/g, " ")
    .replace(/-+/g, " ")
    // Insert space before uppercase letters preceded by lowercase (camelCase)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    // Insert space before uppercase letters followed by lowercase (e.g. XMLParser → XML Parser)
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");

  return withSpaces
    .split(/\s+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length > 1);
}

/**
 * Extracts keywords from a symbol's name and signature.
 * Returns lowercase, deduplicated strings with stop words removed.
 */
export function extractKeywords(symbol: Symbol): string[] {
  const words: string[] = [];

  // Extract from name
  words.push(...splitIdentifier(symbol.name));

  // Extract from signature if present
  if (symbol.signature) {
    // Pull out identifiers from the signature (word characters only)
    const sigTokens = symbol.signature.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? [];
    for (const token of sigTokens) {
      words.push(...splitIdentifier(token));
    }
  }

  // Deduplicate and filter stop words
  const seen = new Set<string>();
  const result: string[] = [];
  for (const word of words) {
    if (!seen.has(word) && !STOP_WORDS.has(word) && word.length > 1) {
      seen.add(word);
      result.push(word);
    }
  }
  return result;
}

/**
 * Builds a keyword index mapping keyword → array of symbol IDs.
 */
export function buildKeywordIndex(symbols: Symbol[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const symbol of symbols) {
    const keywords = extractKeywords(symbol);
    for (const keyword of keywords) {
      const existing = index.get(keyword);
      if (existing) {
        existing.push(symbol.id);
      } else {
        index.set(keyword, [symbol.id]);
      }
    }
  }
  return index;
}
