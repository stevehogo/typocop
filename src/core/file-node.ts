import type { Language } from "./domain.js";

/** Enriched file entry with language detection — still no content. */
export interface FileNode {
  readonly path: string;
  readonly size: number;
  readonly language: Language;
}
