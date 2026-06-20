import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileEmbeddingCache } from "./embedding-cache.js";
import type { Embedding } from "../../core/domain.js";

const embed = (vector: number[]): Embedding => ({
  vector,
  dimensions: vector.length,
});

describe("FileEmbeddingCache", () => {
  let dir: string;
  let cachePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "typocop-embed-cache-"));
    cachePath = join(dir, "nested", "embedding-cache.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns undefined for a missing hash", () => {
    const cache = new FileEmbeddingCache(cachePath);
    expect(cache.get("nope", 3)).toBeUndefined();
  });

  it("stores and retrieves an embedding by hash + dimension", () => {
    const cache = new FileEmbeddingCache(cachePath);
    cache.setMany([{ textHash: "h1", embedding: embed([1, 2, 3]) }]);
    expect(cache.get("h1", 3)).toEqual({ vector: [1, 2, 3], dimensions: 3 });
  });

  it("treats a dimension mismatch as a miss (model swap)", () => {
    const cache = new FileEmbeddingCache(cachePath);
    cache.setMany([{ textHash: "h1", embedding: embed([1, 2, 3]) }]);
    // Same hash, different expected dimension → miss.
    expect(cache.get("h1", 4)).toBeUndefined();
    // Correct dimension still hits.
    expect(cache.get("h1", 3)).toBeDefined();
  });

  it("overwrites an existing hash on a later setMany", () => {
    const cache = new FileEmbeddingCache(cachePath);
    cache.setMany([{ textHash: "h1", embedding: embed([1, 1]) }]);
    cache.setMany([{ textHash: "h1", embedding: embed([9, 9]) }]);
    expect(cache.get("h1", 2)).toEqual({ vector: [9, 9], dimensions: 2 });
  });

  it("round-trips through disk via flush + reload", async () => {
    const cache = new FileEmbeddingCache(cachePath);
    cache.setMany([
      { textHash: "h1", embedding: embed([1, 2]) },
      { textHash: "h2", embedding: embed([3, 4]) },
    ]);
    await cache.flush();

    const reloaded = new FileEmbeddingCache(cachePath);
    expect(reloaded.get("h1", 2)).toEqual({ vector: [1, 2], dimensions: 2 });
    expect(reloaded.get("h2", 2)).toEqual({ vector: [3, 4], dimensions: 2 });
  });

  it("prune(live) drops entries not in the live set", () => {
    const cache = new FileEmbeddingCache(cachePath);
    cache.setMany([
      { textHash: "keep", embedding: embed([1]) },
      { textHash: "drop", embedding: embed([2]) },
    ]);
    cache.prune(new Set(["keep"]));
    expect(cache.get("keep", 1)).toBeDefined();
    expect(cache.get("drop", 1)).toBeUndefined();
  });

  it("enforces the size cap with FIFO eviction", () => {
    const cache = new FileEmbeddingCache(cachePath, 2);
    cache.setMany([{ textHash: "a", embedding: embed([1]) }]);
    cache.setMany([{ textHash: "b", embedding: embed([2]) }]);
    cache.setMany([{ textHash: "c", embedding: embed([3]) }]); // evicts oldest "a"
    expect(cache.get("a", 1)).toBeUndefined();
    expect(cache.get("b", 1)).toBeDefined();
    expect(cache.get("c", 1)).toBeDefined();
  });

  it("load NEVER throws on a corrupt manifest → empty cache", async () => {
    await writeFile(cachePath.replace("nested/", ""), "not json", "utf8");
    // Point a cache at a corrupt file directly.
    const corruptPath = join(dir, "corrupt.json");
    await writeFile(corruptPath, "{ this is : not json", "utf8");
    const cache = new FileEmbeddingCache(corruptPath);
    expect(cache.get("anything", 3)).toBeUndefined();
    // A subsequent flush still produces a valid manifest.
    cache.setMany([{ textHash: "h", embedding: embed([1]) }]);
    await cache.flush();
    const raw = await readFile(corruptPath, "utf8");
    expect(JSON.parse(raw)).toMatchObject({ version: 1 });
  });

  it("load on a missing file yields an empty cache (no throw)", () => {
    const cache = new FileEmbeddingCache(join(dir, "does-not-exist.json"));
    expect(cache.get("x", 1)).toBeUndefined();
  });

  it("skips structurally invalid rows on load", async () => {
    const path = join(dir, "partial.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        entries: {
          good: { dimensions: 2, vector: [1, 2] },
          bad: { dimensions: "two", vector: [1, 2] },
          alsoBad: { vector: "nope" },
        },
      }),
      "utf8",
    );
    const cache = new FileEmbeddingCache(path);
    expect(cache.get("good", 2)).toEqual({ vector: [1, 2], dimensions: 2 });
    expect(cache.get("bad", 2)).toBeUndefined();
    expect(cache.get("alsoBad", 2)).toBeUndefined();
  });
});
