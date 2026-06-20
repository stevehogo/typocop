import { describe, it, expect } from "vitest";
import { classifyFiles, type ClassifiableFile } from "./classify.js";
import type { CachedFileEntry } from "../../../core/ports/index-cache.js";
import type { FileNode } from "../../../core/file-node.js";
import { PARSE_VERSION } from "../../../infrastructure/parsing/parse-version.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const node = (path: string, mtimeMs = 1_000): FileNode => ({
  path,
  size: 100,
  language: "typescript",
  mtimeMs,
});

const file = (path: string, contentHash: string, mtimeMs = 1_000): ClassifiableFile => ({
  fileNode: node(path, mtimeMs),
  contentHash,
});

const entry = (
  contentHash: string,
  overrides: Partial<CachedFileEntry> = {},
): CachedFileEntry => ({
  contentHash,
  mtimeMs: 1_000,
  parseVersion: PARSE_VERSION,
  symbols: [],
  hints: [],
  ...overrides,
});

describe("classifyFiles", () => {
  it("partitions into the four buckets with no overlap", () => {
    const cache = new Map<string, CachedFileEntry>([
      ["same.ts", entry("h-same")],
      ["edited.ts", entry("h-old")],
      ["gone.ts", entry("h-gone")],
    ]);

    const result = classifyFiles(
      [
        file("same.ts", "h-same"), // unchanged: hash matches
        file("edited.ts", "h-new"), // changed: hash differs
        file("brand-new.ts", "h-new2"), // added: not in cache
      ],
      cache,
    );

    expect(result.unchanged.map((f) => f.path)).toEqual(["same.ts"]);
    expect(result.changed.map((f) => f.path)).toEqual(["edited.ts"]);
    expect(result.added.map((f) => f.path)).toEqual(["brand-new.ts"]);
    expect(result.removed).toEqual(["gone.ts"]);
  });

  it("mtime-same / hash-different → changed (hash is authoritative)", () => {
    // Same mtime as the cached entry, but the content hash differs: this is a
    // touched-and-edited file that a naive mtime-only check would wrongly skip.
    const cache = new Map<string, CachedFileEntry>([
      ["a.ts", entry("h-old", { mtimeMs: 5_000 })],
    ]);

    const result = classifyFiles([file("a.ts", "h-new", 5_000)], cache);

    expect(result.changed.map((f) => f.path)).toEqual(["a.ts"]);
    expect(result.unchanged).toEqual([]);
  });

  it("mtime-different / hash-same → unchanged (hash is authoritative)", () => {
    // Different mtime (file was touched), but identical content hash: a naive
    // mtime-only check would wrongly re-parse. Hash wins → unchanged.
    const cache = new Map<string, CachedFileEntry>([
      ["a.ts", entry("h-same", { mtimeMs: 1_000 })],
    ]);

    const result = classifyFiles([file("a.ts", "h-same", 9_999)], cache);

    expect(result.unchanged.map((f) => f.path)).toEqual(["a.ts"]);
    expect(result.changed).toEqual([]);
  });

  it("treats a parseVersion mismatch as changed even when the hash matches", () => {
    const cache = new Map<string, CachedFileEntry>([
      ["a.ts", entry("h-same", { parseVersion: PARSE_VERSION - 1 })],
    ]);

    const result = classifyFiles([file("a.ts", "h-same")], cache);

    expect(result.changed.map((f) => f.path)).toEqual(["a.ts"]);
    expect(result.unchanged).toEqual([]);
  });

  it("classifies a cached file as changed when no contentHash is supplied", () => {
    const cache = new Map<string, CachedFileEntry>([["a.ts", entry("h")]]);

    const result = classifyFiles([{ fileNode: node("a.ts") }], cache);

    expect(result.changed.map((f) => f.path)).toEqual(["a.ts"]);
  });

  it("empty cache → every walked file is added, nothing removed", () => {
    const result = classifyFiles(
      [file("a.ts", "h1"), file("b.ts", "h2")],
      new Map(),
    );

    expect(result.added.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(result.unchanged).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it("empty walk → every cached entry is removed", () => {
    const cache = new Map<string, CachedFileEntry>([
      ["a.ts", entry("h1")],
      ["b.ts", entry("h2")],
    ]);

    const result = classifyFiles([], cache);

    expect(result.removed.sort()).toEqual(["a.ts", "b.ts"]);
    expect(result.added).toEqual([]);
  });
});
