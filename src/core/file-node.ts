import type { Language } from "./domain.js";

/** Enriched file entry with language detection — still no content. */
export interface FileNode {
  readonly path: string;
  readonly size: number;
  readonly language: Language;
  /**
   * Last-modified time in epoch milliseconds (`fs.Stats.mtimeMs`), captured by
   * the Phase-1 structure walk which already `fs.stat`s every file (A2). Used by
   * the parse-cache classifier as the cheap first tier of the two-tier staleness
   * check (cheap `mtimeMs` compare → `sha256(content)` confirm).
   */
  readonly mtimeMs: number;
}
