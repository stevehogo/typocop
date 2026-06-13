import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadSwiftPackageConfig } from "./language-config.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
}));

import { readdir } from "node:fs/promises";

const mockReaddir = readdir as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntries(names: string[], asDir = true) {
  return names.map((name) => ({
    name,
    isDirectory: () => asDir,
    isFile: () => !asDir,
  }));
}

// ---------------------------------------------------------------------------
// loadSwiftPackageConfig
// ---------------------------------------------------------------------------

describe("loadSwiftPackageConfig", () => {
  it("finds targets in Sources/ directory", async () => {
    mockReaddir
      .mockResolvedValueOnce(makeEntries(["MyLib", "MyApp"])) // Sources/
      .mockRejectedValueOnce(new Error("ENOENT"))             // Package/Sources/
      .mockRejectedValueOnce(new Error("ENOENT"));            // src/

    const result = await loadSwiftPackageConfig("/repo");

    expect(result).not.toBeNull();
    expect(result!.targets.get("MyLib")).toBe("Sources/MyLib");
    expect(result!.targets.get("MyApp")).toBe("Sources/MyApp");
  });

  it("finds targets in Package/Sources/ directory", async () => {
    mockReaddir
      .mockRejectedValueOnce(new Error("ENOENT"))             // Sources/
      .mockResolvedValueOnce(makeEntries(["Core", "Utils"]))  // Package/Sources/
      .mockRejectedValueOnce(new Error("ENOENT"));            // src/

    const result = await loadSwiftPackageConfig("/repo");

    expect(result).not.toBeNull();
    expect(result!.targets.get("Core")).toBe("Package/Sources/Core");
    expect(result!.targets.get("Utils")).toBe("Package/Sources/Utils");
  });

  it("finds targets in src/ directory", async () => {
    mockReaddir
      .mockRejectedValueOnce(new Error("ENOENT"))             // Sources/
      .mockRejectedValueOnce(new Error("ENOENT"))             // Package/Sources/
      .mockResolvedValueOnce(makeEntries(["Feature"]));       // src/

    const result = await loadSwiftPackageConfig("/repo");

    expect(result).not.toBeNull();
    expect(result!.targets.get("Feature")).toBe("src/Feature");
  });

  it("merges targets from multiple source directories when they all exist", async () => {
    mockReaddir
      .mockResolvedValueOnce(makeEntries(["LibA"]))           // Sources/
      .mockResolvedValueOnce(makeEntries(["LibB"]))           // Package/Sources/
      .mockResolvedValueOnce(makeEntries(["LibC"]));          // src/

    const result = await loadSwiftPackageConfig("/repo");

    expect(result).not.toBeNull();
    expect(result!.targets.size).toBe(3);
    expect(result!.targets.get("LibA")).toBe("Sources/LibA");
    expect(result!.targets.get("LibB")).toBe("Package/Sources/LibB");
    expect(result!.targets.get("LibC")).toBe("src/LibC");
  });

  it("returns null when none of the source directories exist", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));

    const result = await loadSwiftPackageConfig("/repo");

    expect(result).toBeNull();
  });

  it("returns null when source directories exist but contain no subdirectories (only files)", async () => {
    mockReaddir
      .mockResolvedValueOnce(makeEntries(["Package.swift", "README.md"], false)) // Sources/ — files only
      .mockRejectedValueOnce(new Error("ENOENT"))                                // Package/Sources/
      .mockRejectedValueOnce(new Error("ENOENT"));                               // src/

    const result = await loadSwiftPackageConfig("/repo");

    expect(result).toBeNull();
  });

  it("never throws", async () => {
    mockReaddir.mockRejectedValue(new Error("EACCES: permission denied"));

    await expect(loadSwiftPackageConfig("/repo")).resolves.toBeNull();
  });
});
