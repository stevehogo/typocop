import Parser from "tree-sitter";
import type { Language } from "../types/index.js";

/**
 * Initialize a tree-sitter Parser with the grammar for the given language.
 * Throws a clear error if the grammar package is missing or unsupported.
 */
export async function initParser(language: Language): Promise<Parser> {
  const parser = new Parser();
  const grammar = await loadGrammar(language);
  parser.setLanguage(grammar);
  return parser;
}

async function loadGrammar(language: Language): Promise<unknown> {
  switch (language) {
    case "typescript": {
      const mod = await import("tree-sitter-typescript");
      return (mod.default as { typescript: unknown }).typescript;
    }
    case "javascript": {
      const mod = await import("tree-sitter-javascript");
      return mod.default;
    }
    case "python": {
      const mod = await import("tree-sitter-python");
      return mod.default;
    }
    case "php": {
      const mod = await import("tree-sitter-php");
      // tree-sitter-php exports { php, php_only } — use php_only for modern PHP
      const phpMod = mod.default as { php_only?: unknown; php?: unknown };
      return phpMod.php_only ?? phpMod.php ?? mod.default;
    }
    case "java": {
      const mod = await import("tree-sitter-java");
      return mod.default;
    }
    case "go": {
      const mod = await import("tree-sitter-go");
      return mod.default;
    }
    case "rust": {
      const mod = await import("tree-sitter-rust");
      return mod.default;
    }
    case "c": {
      const mod = await import("tree-sitter-c");
      return mod.default;
    }
    case "cpp": {
      const mod = await import("tree-sitter-cpp");
      return mod.default;
    }
    case "csharp": {
      const mod = await import("tree-sitter-c-sharp");
      return mod.default;
    }
    case "ruby": {
      const mod = await import("tree-sitter-ruby");
      return mod.default;
    }
    case "swift": {
      try {
        const mod = await import("tree-sitter-swift");
        return mod.default;
      } catch {
        throw new Error(
          "Swift grammar (tree-sitter-swift) is not installed. " +
          "Run: pnpm add tree-sitter-swift"
        );
      }
    }
    default: {
      const exhaustive: never = language;
      throw new Error(`Unsupported language: ${String(exhaustive)}`);
    }
  }
}
