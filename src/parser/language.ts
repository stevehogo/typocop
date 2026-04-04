import path from "path";
import type { Language } from "../types/index.js";

// Re-export Language type for convenience
export type { Language };

/** Map from file extension to Language */
export const EXTENSION_TO_LANGUAGE: Readonly<Record<string, Language>> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".php": "php",
  ".java": "java",
  ".go": "go",
  ".rs": "rust",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".swift": "swift",
};

/**
 * Detect the programming language from a file path based on its extension.
 * Returns null if the extension is not recognized.
 */
export function detectLanguage(filePath: string): Language | null {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}
