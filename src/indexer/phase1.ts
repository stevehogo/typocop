import * as fs from "fs/promises";
import { Dirent } from "fs";
import * as path from "path";
import type { Language, Symbol } from "../types/index.js";
import { detectLanguage } from "../parser/index.js";

export interface FileNode {
  path: string;
  language: Language;
  symbols: Symbol[];
}

export async function walkFileTree(rootPath: string): Promise<FileNode[]> {
  const fileNodes: FileNode[] = [];

  async function walk(currentPath: string) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch (err) {
      console.warn(`Warning: Could not read directory ${currentPath}`, err);
      return;
    }

    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") {
        continue;
      }

      const fullPath = path.join(currentPath, entry.name);
      
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        const lang = detectLanguage(fullPath);
        if (lang) {
          fileNodes.push({
            path: fullPath,
            language: lang,
            symbols: []
          });
        }
      }
    }
  }

  await walk(rootPath);
  return fileNodes;
}
