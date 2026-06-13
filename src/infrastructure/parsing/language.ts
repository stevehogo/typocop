import path from "path";
import { readdirSync, statSync } from "node:fs";
import type { Language } from "../../core/domain.js";

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

/**
 * Detect the dominant language in a directory by sampling file extensions.
 * Walks up to `maxDepth` levels deep and returns the most frequent language found.
 * Returns null if no recognized source files are found.
 */
export function detectDirectoryLanguage(
  dirPath: string,
  maxDepth = 3
): Language | null {
  const counts = new Map<Language, number>();

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules" || entry === "vendor" || entry === "dist") {
        continue;
      }
      const full = path.join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full, depth + 1);
      } else {
        const lang = detectLanguage(full);
        if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
      }
    }
  }

  walk(dirPath, 0);

  if (counts.size === 0) return null;

  return [...counts.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}
