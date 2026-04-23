import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../../package.json";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");

describe("package.json field assertions", () => {
  it("declares bin field with typocop and typocop-mcp", () => {
    expect(pkg.bin).toEqual({
      typocop: "dist/cli/main.js",
      "typocop-mcp": "dist/mcp/main.js",
    });
  });

  it("declares files field with dist and README.md", () => {
    expect(pkg.files).toEqual(["dist", "README.md"]);
  });

  it("declares engines with node >=20.0.0", () => {
    expect(pkg.engines).toEqual({ node: ">=20.0.0" });
  });

  it("declares scripts.build as tsc", () => {
    expect(pkg.scripts.build).toBe("tsc");
  });

  it("declares scripts.prepublishOnly as pnpm run build", () => {
    expect(pkg.scripts.prepublishOnly).toBe("pnpm run build");
  });

  it("declares scripts.postbuild with chmod on both entry points", () => {
    expect(pkg.scripts.postbuild).toBe(
      "chmod +x dist/cli/main.js dist/mcp/main.js"
    );
  });

  it("declares scripts.clean to remove dist", () => {
    expect(pkg.scripts.clean).toBe("rm -rf dist");
  });

  it('declares type as "module"', () => {
    expect((pkg as Record<string, unknown>).type).toBe("module");
  });

  it("declares dotenv as a runtime dependency", () => {
    expect(pkg.dependencies.dotenv).toMatch(/^\^1[67]\./);
  });
});

describe(".env.example assertions", () => {
  const envExample = readFileSync(resolve(root, ".env.example"), "utf-8");

  const requiredVars = [
    "LADYBUGDB_PATH",
    "OLLAMA_ENABLED",
    "OLLAMA_URL",
    "OLLAMA_MODEL",
    "OLLAMA_DIMENSIONS",
  ];

  for (const varName of requiredVars) {
    it(`contains ${varName}`, () => {
      expect(envExample).toContain(varName);
    });
  }

  const removedVars = [
    "NEO4J_URI",
    "NEO4J_USER",
    "NEO4J_PASSWORD",
    "POSTGRES_HOST",
    "POSTGRES_PORT",
    "POSTGRES_DB",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "OPENAI_API_KEY",
  ];

  for (const varName of removedVars) {
    it(`does not contain removed var ${varName}`, () => {
      // These vars should not appear as active env vars (may appear in comments)
      const lines = envExample.split("\n").filter(l => !l.startsWith("#"));
      const hasActiveVar = lines.some(l => l.includes(varName));
      expect(hasActiveVar).toBe(false);
    });
  }
});
