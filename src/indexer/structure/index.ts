import * as fs from "fs/promises";
import * as path from "path";
import type { Language } from "../../types/index.js";
import { shouldIgnorePath } from "../../utils/ignore.js";
import { MAX_FILE_SIZE } from "../../utils/limits.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Lightweight stat-only entry — no content loaded into memory */
export interface ScannedFile {
  readonly path: string;
  readonly size: number;
}

/** Enriched file entry with language detection — still no content */
export interface FileNode {
  readonly path: string;
  readonly size: number;
  readonly language: Language;
}

// ─── Extension → Language map ─────────────────────────────────────────────────

const EXT_TO_LANGUAGE: Readonly<Record<string, Language>> = {
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
 * Detect language from a file path by extension.
 * Returns undefined for unrecognised extensions.
 */
export const detectLanguageFromPath = (filePath: string): Language | undefined => {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_LANGUAGE[ext];
};

// ─── Phase 1: stat-only walk ──────────────────────────────────────────────────

const READ_CONCURRENCY = 32;

/**
 * Phase 1 — Walk the file tree and return FileNode[] (path + size + language).
 * No file content is loaded into memory.
 * Files larger than MAX_FILE_SIZE or with unrecognised extensions are skipped.
 */
export const walkFileTree = async (rootPath: string): Promise<FileNode[]> => {
  const relativePaths: string[] = [];

  // Recursive directory scan — collect relative paths only
  const collect = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.warn(`Warning: Could not read directory ${dir}`, err);
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(rootPath, fullPath).replace(/\\/g, "/");

      if (shouldIgnorePath(relativePath)) continue;

      if (entry.isDirectory()) {
        await collect(fullPath);
      } else if (entry.isFile()) {
        relativePaths.push(relativePath);
      }
    }
  };

  await collect(rootPath);

  // Stat files in batches — skip oversized and unrecognised files
  const fileNodes: FileNode[] = [];
  let skippedLarge = 0;

  for (let i = 0; i < relativePaths.length; i += READ_CONCURRENCY) {
    const batch = relativePaths.slice(i, i + READ_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (relativePath) => {
        const language = detectLanguageFromPath(relativePath);
        if (!language) return null; // skip unrecognised extensions

        const fullPath = path.join(rootPath, relativePath);
        const stat = await fs.stat(fullPath);
        if (stat.size > MAX_FILE_SIZE) return "large" as const;

        return { path: relativePath, size: stat.size, language } satisfies FileNode;
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value === "large") {
          skippedLarge++;
        } else if (result.value !== null) {
          fileNodes.push(result.value);
        }
      }
    }
  }

  if (skippedLarge > 0) {
    console.warn(
      `Phase 1: skipped ${skippedLarge} large files (>${MAX_FILE_SIZE / 1024}KB)`
    );
  }

  return fileNodes;
};

// ─── Phase 2 helper: on-demand content reads ─────────────────────────────────

/**
 * Read file contents for a specific set of relative paths.
 * Returns a Map<relativePath, content> for O(1) lookup.
 * Files that fail to read are silently skipped.
 */
export const readFileContents = async (
  rootPath: string,
  relativePaths: string[]
): Promise<Map<string, string>> => {
  const contents = new Map<string, string>();

  for (let i = 0; i < relativePaths.length; i += READ_CONCURRENCY) {
    const batch = relativePaths.slice(i, i + READ_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (relativePath) => {
        const fullPath = path.join(rootPath, relativePath);
        const content = await fs.readFile(fullPath, "utf-8");
        return { path: relativePath, content };
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        contents.set(result.value.path, result.value.content);
      }
    }
  }

  return contents;
};
