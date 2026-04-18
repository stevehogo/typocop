import { describe, it, expect } from "vitest";
import * as os from "os";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { walkFileTree } from "./index.js";

// ─── Integration smoke test: walkFileTree with real filesystem ────────────────
// This file intentionally does NOT mock fs/promises so walkFileTree uses the
// real filesystem. The unit tests in index.test.ts use vi.mock("fs/promises").

describe("walkFileTree integration — ignore filtering", () => {
  it("returns only src/index.ts from a fixture with ignored paths", async () => {
    const tmpDir = await mkdtemp(`${os.tmpdir()}/ignore-smoke-`);
    try {
      // Arrange: create ignored paths alongside one valid source file
      await mkdir(`${tmpDir}/node_modules`, { recursive: true });
      await writeFile(`${tmpDir}/node_modules/foo.ts`, "");
      await mkdir(`${tmpDir}/src`, { recursive: true });
      await writeFile(`${tmpDir}/src/index.ts`, "export const x = 1;");
      await writeFile(`${tmpDir}/logo.png`, "");
      await writeFile(`${tmpDir}/package-lock.json`, "{}");

      // Act
      const result = await walkFileTree(tmpDir);

      // Assert: only src/index.ts survives filtering
      const paths = result.map((f) => f.path);
      expect(paths.length).toBe(1);
      expect(paths[0]).toBe("src/index.ts");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
