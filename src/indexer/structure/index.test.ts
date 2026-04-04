import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { walkFileTree, readFileContents, detectLanguageFromPath } from "./index.js";
import { MAX_FILE_SIZE } from "../../utils/limits.js";

vi.mock("fs/promises");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const makeDirent = (name: string, isDir: boolean) => ({
  name,
  isDirectory: () => isDir,
  isFile: () => !isDir,
  isBlockDevice: () => false,
  isCharacterDevice: () => false,
  isSymbolicLink: () => false,
  isFIFO: () => false,
  isSocket: () => false,
  path: "",
});

const makeStat = (size: number) => ({ size } as Awaited<ReturnType<typeof fs.stat>>);

// ─── detectLanguageFromPath ───────────────────────────────────────────────────

describe("detectLanguageFromPath", () => {
  it.each([
    ["app.ts", "typescript"],
    ["component.tsx", "typescript"],
    ["index.js", "javascript"],
    ["module.mjs", "javascript"],
    ["script.cjs", "javascript"],
    ["view.jsx", "javascript"],
    ["main.py", "python"],
    ["Controller.php", "php"],
    ["Main.java", "java"],
    ["server.go", "go"],
    ["lib.rs", "rust"],
    ["main.c", "c"],
    ["header.h", "c"],
    ["app.cpp", "cpp"],
    ["app.cc", "cpp"],
    ["app.cxx", "cpp"],
    ["app.hpp", "cpp"],
    ["Program.cs", "csharp"],
    ["model.rb", "ruby"],
    ["App.swift", "swift"],
  ])("detects %s as %s", (file, expected) => {
    expect(detectLanguageFromPath(file)).toBe(expected);
  });

  it("returns undefined for unrecognised extensions", () => {
    expect(detectLanguageFromPath("style.css")).toBeUndefined();
    expect(detectLanguageFromPath("README.md")).toBeUndefined();
    expect(detectLanguageFromPath("image.png")).toBeUndefined();
  });
});

// ─── walkFileTree ─────────────────────────────────────────────────────────────

describe("walkFileTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array for empty directory", async () => {
    vi.mocked(fs.readdir).mockResolvedValue([]);

    const result = await walkFileTree("/repo");

    expect(result).toEqual([]);
  });

  it("skips ignored directories (node_modules, .git, dist, vendor, etc.)", async () => {
    vi.mocked(fs.readdir).mockImplementation(async (dir) => {
      if (dir === "/repo") {
        return [
          makeDirent("node_modules", true),
          makeDirent(".git", true),
          makeDirent("dist", true),
          makeDirent("src", true),
        ] as never;
      }
      if (dir === path.join("/repo", "src")) {
        return [makeDirent("index.ts", false)] as never;
      }
      return [] as never;
    });
    vi.mocked(fs.stat).mockResolvedValue(makeStat(1024));

    const result = await walkFileTree("/repo");

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/index.ts");
    expect(fs.readdir).not.toHaveBeenCalledWith(
      path.join("/repo", "node_modules"),
      expect.anything()
    );
  });

  it("returns FileNode with path, size, and language — no content", async () => {
    vi.mocked(fs.readdir).mockImplementation(async (dir) => {
      if (dir === "/repo") {
        return [makeDirent("app.ts", false)] as never;
      }
      return [] as never;
    });
    vi.mocked(fs.stat).mockResolvedValue(makeStat(2048));

    const result = await walkFileTree("/repo");

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ path: "app.ts", size: 2048, language: "typescript" });
  });

  it("skips files with unrecognised extensions", async () => {
    vi.mocked(fs.readdir).mockImplementation(async (dir) => {
      if (dir === "/repo") {
        return [
          makeDirent("style.css", false),
          makeDirent("README.md", false),
          makeDirent("main.go", false),
        ] as never;
      }
      return [] as never;
    });
    vi.mocked(fs.stat).mockResolvedValue(makeStat(512));

    const result = await walkFileTree("/repo");

    expect(result).toHaveLength(1);
    expect(result[0].language).toBe("go");
  });

  it("skips files larger than MAX_FILE_SIZE", async () => {
    vi.mocked(fs.readdir).mockImplementation(async (dir) => {
      if (dir === "/repo") {
        return [
          makeDirent("small.ts", false),
          makeDirent("huge.ts", false),
        ] as never;
      }
      return [] as never;
    });
    vi.mocked(fs.stat).mockImplementation(async (p) => {
      const filePath = String(p);
      return makeStat(filePath.includes("huge") ? MAX_FILE_SIZE + 1 : 1024);
    });

    const result = await walkFileTree("/repo");

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("small.ts");
  });

  it("handles readdir errors gracefully by skipping the directory", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fs.readdir).mockImplementation(async (dir) => {
      if (dir === "/repo") {
        return [
          makeDirent("good", true),
          makeDirent("bad", true),
        ] as never;
      }
      if (dir === path.join("/repo", "good")) {
        return [makeDirent("index.ts", false)] as never;
      }
      throw new Error("Permission denied");
    });
    vi.mocked(fs.stat).mockResolvedValue(makeStat(512));

    const result = await walkFileTree("/repo");

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("good/index.ts");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("detects multiple languages in a mixed-language repo", async () => {
    vi.mocked(fs.readdir).mockImplementation(async (dir) => {
      if (dir === "/repo") {
        return [
          makeDirent("main.py", false),
          makeDirent("server.go", false),
          makeDirent("app.ts", false),
          makeDirent("lib.rs", false),
        ] as never;
      }
      return [] as never;
    });
    vi.mocked(fs.stat).mockResolvedValue(makeStat(256));

    const result = await walkFileTree("/repo");

    expect(result).toHaveLength(4);
    const langs = result.map((f) => f.language).sort();
    expect(langs).toEqual(["go", "python", "rust", "typescript"]);
  });
});

// ─── readFileContents ─────────────────────────────────────────────────────────

describe("readFileContents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a Map with file contents keyed by relative path", async () => {
    vi.mocked(fs.readFile).mockImplementation(async (p) => {
      if (String(p).endsWith("a.ts")) return "const a = 1;";
      if (String(p).endsWith("b.ts")) return "const b = 2;";
      return "";
    });

    const result = await readFileContents("/repo", ["a.ts", "b.ts"]);

    expect(result.get("a.ts")).toBe("const a = 1;");
    expect(result.get("b.ts")).toBe("const b = 2;");
  });

  it("silently skips files that fail to read", async () => {
    vi.mocked(fs.readFile).mockImplementation(async (p) => {
      if (String(p).endsWith("good.ts")) return "ok";
      throw new Error("ENOENT");
    });

    const result = await readFileContents("/repo", ["good.ts", "missing.ts"]);

    expect(result.size).toBe(1);
    expect(result.has("good.ts")).toBe(true);
    expect(result.has("missing.ts")).toBe(false);
  });

  it("returns empty Map for empty input", async () => {
    const result = await readFileContents("/repo", []);
    expect(result.size).toBe(0);
  });
});
