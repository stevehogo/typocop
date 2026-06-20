import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileIndexCache } from "./file-index-cache.js";
import type { CachedFileEntry } from "../../core/ports/index-cache.js";

const makeEntry = (overrides: Partial<CachedFileEntry> = {}): CachedFileEntry => ({
  contentHash: "abc123",
  mtimeMs: 1_700_000_000_000,
  parseVersion: 1,
  symbols: [
    {
      id: "id-1",
      logicalKey: "lk-1",
      name: "doThing",
      kind: "function",
      location: {
        filePath: "src/a.ts",
        startLine: 1,
        endLine: 3,
        startColumn: 0,
        endColumn: 1,
      },
      visibility: "public",
      modifiers: [],
    },
  ],
  hints: [
    {
      kind: "call",
      sourceFile: "src/a.ts",
      targetName: "helper",
      startLine: 2,
      language: "typescript",
    },
  ],
  ...overrides,
});

describe("FileIndexCache", () => {
  let dir: string;
  let cachePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "typocop-cache-"));
    cachePath = join(dir, "nested", "parse-cache.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips the cache map identically (save → load)", async () => {
    const cache = new FileIndexCache(cachePath);
    const input = new Map<string, CachedFileEntry>([
      ["src/a.ts", makeEntry()],
      ["src/b.ts", makeEntry({ contentHash: "def456", symbols: [], hints: [] })],
    ]);

    await cache.save(input);
    const loaded = await cache.load();

    expect(loaded).toEqual(input);
    // Structural deep-equality of a representative entry.
    expect(loaded.get("src/a.ts")).toEqual(input.get("src/a.ts"));
  });

  it("creates parent directories on save (atomic temp + rename)", async () => {
    const cache = new FileIndexCache(cachePath);
    await cache.save(new Map([["x.ts", makeEntry()]]));
    // The manifest exists and is valid JSON with the expected envelope.
    const raw = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.entries["x.ts"].contentHash).toBe("abc123");
  });

  it("returns an empty Map when the manifest is missing (never throws)", async () => {
    const cache = new FileIndexCache(join(dir, "does-not-exist.json"));
    const loaded = await cache.load();
    expect(loaded.size).toBe(0);
  });

  it("returns an empty Map on a corrupt (non-JSON) manifest (never throws)", async () => {
    await mkdir(dir, { recursive: true });
    const corruptPath = join(dir, "corrupt.json");
    await writeFile(corruptPath, "{ this is : not json ]]]", "utf8");

    const cache = new FileIndexCache(corruptPath);
    await expect(cache.load()).resolves.toBeInstanceOf(Map);
    expect((await cache.load()).size).toBe(0);
  });

  it("returns an empty Map when JSON is valid but the shape is wrong", async () => {
    await mkdir(dir, { recursive: true });
    const badShapePath = join(dir, "bad-shape.json");
    await writeFile(badShapePath, JSON.stringify(["not", "an", "object"]), "utf8");

    const cache = new FileIndexCache(badShapePath);
    expect((await cache.load()).size).toBe(0);
  });

  it("clear() removes the manifest and is a no-op when absent", async () => {
    const cache = new FileIndexCache(cachePath);
    await cache.save(new Map([["x.ts", makeEntry()]]));

    await cache.clear();
    expect((await cache.load()).size).toBe(0);

    // Second clear on a now-missing file must not throw.
    await expect(cache.clear()).resolves.toBeUndefined();
  });

  it("a second save overwrites the prior manifest", async () => {
    const cache = new FileIndexCache(cachePath);
    await cache.save(new Map([["a.ts", makeEntry()]]));
    await cache.save(new Map([["b.ts", makeEntry({ contentHash: "zzz" })]]));

    const loaded = await cache.load();
    expect([...loaded.keys()]).toEqual(["b.ts"]);
    expect(loaded.get("b.ts")?.contentHash).toBe("zzz");
  });
});
