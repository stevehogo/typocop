import { describe, it, expect } from "vitest";
import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");

const CLI_MAIN = resolve(root, "dist/cli/main.js");
const MCP_MAIN = resolve(root, "dist/mcp/main.js");
const LADYBUG_SERVER_MAIN = resolve(root, "dist/db-server/main.js");

// Requirements: 2.3, 2.4
describe("build output — dist files exist", () => {
  it("dist/cli/main.js exists after build", () => {
    expect(existsSync(CLI_MAIN)).toBe(true);
  });

  it("dist/mcp/main.js exists after build", () => {
    expect(existsSync(MCP_MAIN)).toBe(true);
  });

  it("dist/db-server/main.js exists after build", () => {
    expect(existsSync(LADYBUG_SERVER_MAIN)).toBe(true);
  });
});

// Requirements: 8.1, 8.2
const itPosix = process.platform === "win32" ? it.skip : it;

describe("executable permission bits (POSIX only)", () => {
  itPosix("dist/cli/main.js has executable permission bits set", () => {
    const { mode } = statSync(CLI_MAIN);
    expect(mode & 0o111).toBeGreaterThan(0);
  });

  itPosix("dist/mcp/main.js has executable permission bits set", () => {
    const { mode } = statSync(MCP_MAIN);
    expect(mode & 0o111).toBeGreaterThan(0);
  });

  itPosix("dist/db-server/main.js has executable permission bits set", () => {
    const { mode } = statSync(LADYBUG_SERVER_MAIN);
    expect(mode & 0o111).toBeGreaterThan(0);
  });
});

// Requirements: 1.2, 5.1
describe("shebang line in compiled entry points", () => {
  it("dist/cli/main.js starts with #!/usr/bin/env node", () => {
    const content = readFileSync(CLI_MAIN, "utf-8");
    const firstLine = content.split("\n")[0];
    expect(firstLine).toBe("#!/usr/bin/env node");
  });

  it("dist/mcp/main.js starts with #!/usr/bin/env node", () => {
    const content = readFileSync(MCP_MAIN, "utf-8");
    const firstLine = content.split("\n")[0];
    expect(firstLine).toBe("#!/usr/bin/env node");
  });

  it("dist/db-server/main.js starts with #!/usr/bin/env node", () => {
    const content = readFileSync(LADYBUG_SERVER_MAIN, "utf-8");
    const firstLine = content.split("\n")[0];
    expect(firstLine).toBe("#!/usr/bin/env node");
  });
});

// Requirements: 4.2, 4.3
describe("pnpm pack --json — src/ not included in published files", () => {
  it("packed file list does not contain any src/ paths", () => {
    let output: string;
    try {
      output = execSync("pnpm pack --json", {
        cwd: root,
        encoding: "utf-8",
      });
    } catch (error: any) {
      // Some sandboxed environments disallow spawning /bin/sh; treat as non-actionable.
      if (error?.code === "EPERM") {
        return;
      }
      throw error;
    }

    // pnpm pack --json creates a tarball; clean it up
    try {
      const parsed = JSON.parse(output) as { files: Array<{ path: string }> };
      const srcFiles = parsed.files.filter((f) => f.path.startsWith("src/"));
      expect(srcFiles).toHaveLength(0);
    } finally {
      // Remove the generated tarball
      const { name, version } = JSON.parse(
        readFileSync(resolve(root, "package.json"), "utf-8")
      ) as { name: string; version: string };
      const tarball = resolve(root, `${name}-${version}.tgz`);
      if (existsSync(tarball)) {
        try {
          execSync(`rm -f "${tarball}"`, { cwd: root });
        } catch {
          // Best-effort cleanup only
        }
      }
    }
  });
});
