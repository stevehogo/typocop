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
 * Progress callback invoked after each file is stat-checked.
 * @param scanned - monotonically increasing count of files processed so far
 * @param total   - total candidate paths collected before stat phase
 * @param filePath - relative path of the file just processed
 */
export type WalkProgressCallback = (
  scanned: number,
  total: number,
  filePath: string
) => void;

/**
 * Phase 1 — Walk the file tree and return FileNode[] (path + size + language).
 * No file content is loaded into memory.
 * Files larger than MAX_FILE_SIZE or with unrecognised extensions are skipped.
 * Symlinks are skipped — entry.isFile() and entry.isDirectory() both return
 * false for symlinks, so they fall through without being collected.
 */
export const walkFileTree = async (
  rootPath: string,
  onProgress?: WalkProgressCallback
): Promise<FileNode[]> => {
  const relativePaths: string[] = [];
  
  // Normalize and resolve the root path
  const normalizedRoot = path.resolve(rootPath);
  // Get the base name of the root path (e.g., "src" from "./src" or "/home/user/project/src")
  const rootBaseName = path.basename(normalizedRoot);
  // Get the parent directory (used for making paths relative)
  const rootParent = path.dirname(normalizedRoot);

  // Recursive directory scan — collect relative paths only.
  // Symlinks are implicitly skipped: isDirectory() and isFile() both return
  // false for symlinks, so neither branch is taken.
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
      // Make path relative to parent, so it includes the root directory name
      const relativePath = path.relative(rootParent, fullPath).replace(/\\/g, "/");

      if (shouldIgnorePath(relativePath)) continue;

      if (entry.isDirectory()) {
        await collect(fullPath);
      } else if (entry.isFile()) {
        relativePaths.push(relativePath);
      }
      // symlinks: isDirectory() and isFile() are both false → skipped here
    }
  };

  await collect(normalizedRoot);

  const total = relativePaths.length;
  const fileNodes: FileNode[] = [];
  let skippedLarge = 0;
  let scanned = 0;

  for (let i = 0; i < relativePaths.length; i += READ_CONCURRENCY) {
    const batch = relativePaths.slice(i, i + READ_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (relativePath) => {
        const language = detectLanguageFromPath(relativePath);
        if (!language) return { node: null, relativePath };

        const fullPath = path.join(rootParent, relativePath);
        const stat = await fs.stat(fullPath);
        if (stat.size > MAX_FILE_SIZE) return { node: "large" as const, relativePath };

        return { node: { path: relativePath, size: stat.size, language } satisfies FileNode, relativePath };
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        const { node, relativePath } = result.value;
        scanned++;
        onProgress?.(scanned, total, relativePath);
        if (node === "large") {
          skippedLarge++;
        } else if (node !== null) {
          fileNodes.push(node);
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
  
  // Resolve root path and get parent directory
  const normalizedRoot = path.resolve(rootPath);
  const rootParent = path.dirname(normalizedRoot);

  for (let i = 0; i < relativePaths.length; i += READ_CONCURRENCY) {
    const batch = relativePaths.slice(i, i + READ_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (relativePath) => {
        const fullPath = path.join(rootParent, relativePath);
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
