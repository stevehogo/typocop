/**
 * Side effect analysis and type inference for symbols.
 * Requirements: 24.4, 24.5
 */
import type { Symbol } from "../types/index.js";

// Keywords that indicate side effects / mutations / I/O
const MUTATION_KEYWORDS = [
  "save", "update", "delete", "remove", "insert", "create", "write",
  "set", "put", "patch", "post", "push", "pop", "append", "clear",
  "flush", "commit", "rollback", "persist",
];

const IO_KEYWORDS = [
  "read", "fetch", "get", "load", "query", "find", "select",
  "send", "emit", "dispatch", "publish", "notify", "log", "print",
  "request", "response", "http", "file", "stream", "socket",
];

/**
 * Identify side effects and mutations for a symbol based on its name,
 * signature, and modifiers.
 * Requirements: 24.4
 */
export function analyzeSideEffects(symbol: Symbol): string[] {
  const text = `${symbol.name} ${symbol.signature ?? ""}`.toLowerCase();
  const effects: string[] = [];

  if (MUTATION_KEYWORDS.some((kw) => text.includes(kw))) {
    effects.push("mutation");
  }
  if (IO_KEYWORDS.some((kw) => text.includes(kw))) {
    effects.push("io");
  }
  if (symbol.modifiers.includes("async")) {
    effects.push("async");
  }
  if (text.includes("throw") || text.includes("error") || text.includes("exception")) {
    effects.push("throws");
  }

  return effects;
}

// Dynamically typed languages where type inference is useful
const DYNAMIC_LANGUAGES = new Set(["php", "python", "javascript", "ruby"]);

// Simple return-type patterns from signature text
const TYPE_PATTERNS: Array<[RegExp, string]> = [
  [/:\s*string\b/i,  "string"],
  [/:\s*number\b/i,  "number"],
  [/:\s*bool\b/i,    "boolean"],
  [/:\s*int\b/i,     "integer"],
  [/:\s*array\b/i,   "array"],
  [/:\s*void\b/i,    "void"],
  [/:\s*null\b/i,    "null"],
];

/**
 * Infer types for symbols in dynamically typed languages.
 * Returns a map of parameter/return type hints.
 * Requirements: 24.5
 */
export function inferTypes(symbol: Symbol): Record<string, string> {
  const filePath = symbol.location.filePath.toLowerCase();
  const isDynamic = DYNAMIC_LANGUAGES.has(
    filePath.endsWith(".php") ? "php"
    : filePath.endsWith(".py") ? "python"
    : filePath.endsWith(".js") || filePath.endsWith(".mjs") ? "javascript"
    : filePath.endsWith(".rb") ? "ruby"
    : "",
  );

  if (!isDynamic) return {};

  const result: Record<string, string> = {};

  // Signature-based type hints
  if (symbol.signature) {
    for (const [pattern, typeName] of TYPE_PATTERNS) {
      if (pattern.test(symbol.signature)) {
        result["return"] = typeName;
        break;
      }
    }
  }

  // Name-convention inference (fallback)
  if (!result["return"]) {
    const name = symbol.name.toLowerCase();
    if (name.startsWith("is") || name.startsWith("has") || name.startsWith("can")) {
      result["return"] = "boolean";
    } else if (name.startsWith("get") || name.startsWith("find")) {
      result["return"] = "mixed";
    } else if (name.startsWith("count") || name.startsWith("total")) {
      result["return"] = "integer";
    }
  }

  return result;
}
