import { describe, it, expect, vi, beforeEach } from "vitest";
import { detectLanguage, detectDirectoryLanguage } from "./language.js";
import * as fs from "node:fs";

vi.mock("node:fs");

describe("detectLanguage", () => {
  it("detects typescript from .ts extension", () => {
    expect(detectLanguage("src/foo.ts")).toBe("typescript");
  });

  it("detects typescript from .tsx extension", () => {
    expect(detectLanguage("src/foo.tsx")).toBe("typescript");
  });

  it("detects python from .py extension", () => {
    expect(detectLanguage("app/views.py")).toBe("python");
  });

  it("detects php from .php extension", () => {
    expect(detectLanguage("app/Controller.php")).toBe("php");
  });

  it("returns null for unrecognized extension", () => {
    expect(detectLanguage("README.md")).toBeNull();
    expect(detectLanguage("image.png")).toBeNull();
  });
});

describe("detectDirectoryLanguage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns the dominant language based on file count", () => {
    vi.mocked(fs.readdirSync).mockReturnValue(
      ["a.ts", "b.ts", "c.ts", "d.py"] as unknown as fs.Dirent<Buffer<ArrayBuffer>>[]
    );
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false } as fs.Stats);

    const result = detectDirectoryLanguage("/project");
    expect(result).toBe("typescript");
  });

  it("returns null when no recognized files are found", () => {
    vi.mocked(fs.readdirSync).mockReturnValue(
      ["README.md", "LICENSE", ".gitignore"] as unknown as fs.Dirent<Buffer<ArrayBuffer>>[]
    );
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false } as fs.Stats);

    const result = detectDirectoryLanguage("/project");
    expect(result).toBeNull();
  });

  it("skips node_modules, vendor, and dist directories", () => {
    vi.mocked(fs.readdirSync).mockImplementation((dir) => {
      if (String(dir) === "/project") {
        return ["node_modules", "src"] as unknown as fs.Dirent<Buffer<ArrayBuffer>>[];
      }
      if (String(dir).endsWith("src")) {
        return ["index.ts"] as unknown as fs.Dirent<Buffer<ArrayBuffer>>[];
      }
      // node_modules — should never be reached
      return ["evil.php"] as unknown as fs.Dirent<Buffer<ArrayBuffer>>[];
    });
    vi.mocked(fs.statSync).mockImplementation((p) => ({
      isDirectory: () => String(p).endsWith("src") || String(p).endsWith("node_modules"),
    } as fs.Stats));

    const result = detectDirectoryLanguage("/project");
    expect(result).toBe("typescript");
  });
});
