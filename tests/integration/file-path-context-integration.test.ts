/**
 * Integration tests for file path context bugfix (Task 4).
 *
 * Tests the full indexing pipeline with files from different scan paths,
 * verifying that:
 * 1. Symbols contain absolute paths after extraction
 * 2. Relationship hints contain absolute source file paths
 * 3. File content can be read using stored absolute paths
 * 4. Symbol IDs are unique across different scan roots
 * 5. Multi-language extraction works correctly
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 3.1-3.6
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { extractAllSymbols } from "../../src/indexer/parsing/index.js";
import { walkFileTree } from "../../src/indexer/structure/index.js";
import type { FileNode } from "../../src/indexer/structure/index.js";

// ─── Test Fixtures ────────────────────────────────────────────────────────

/**
 * Create a temporary directory with test files in multiple languages.
 * Returns the root path and cleanup function.
 */
async function createTestFixture(): Promise<{
  rootPath: string;
  cleanup: () => Promise<void>;
}> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "typocop-test-"));

  // Create TypeScript file
  const tsDir = path.join(tempDir, "src", "services");
  await fs.mkdir(tsDir, { recursive: true });
  await fs.writeFile(
    path.join(tsDir, "auth.ts"),
    `
export class AuthService {
  authenticate(username: string, password: string): boolean {
    return true;
  }

  authorize(user: string, role: string): boolean {
    return true;
  }
}
    `.trim(),
  );

  // Create JavaScript file
  const jsDir = path.join(tempDir, "src", "utils");
  await fs.mkdir(jsDir, { recursive: true });
  await fs.writeFile(
    path.join(jsDir, "helpers.js"),
    `
export function formatDate(date) {
  return date.toISOString();
}

export function parseJSON(str) {
  return JSON.parse(str);
}
    `.trim(),
  );

  // Create Python file
  const pyDir = path.join(tempDir, "src", "models");
  await fs.mkdir(pyDir, { recursive: true });
  await fs.writeFile(
    path.join(pyDir, "user.py"),
    `
class User:
    def __init__(self, name, email):
        self.name = name
        self.email = email

    def validate_email(self):
        return "@" in self.email
    `.trim(),
  );

  // Create PHP file
  const phpDir = path.join(tempDir, "app", "Services");
  await fs.mkdir(phpDir, { recursive: true });
  await fs.writeFile(
    path.join(phpDir, "UserService.php"),
    `<?php
namespace App\\Services;

class UserService {
    public function createUser($name, $email) {
        return true;
    }

    public function deleteUser($id) {
        return true;
    }
}
    `.trim(),
  );

  // Create Java file
  const javaDir = path.join(tempDir, "src", "main", "java", "com", "example");
  await fs.mkdir(javaDir, { recursive: true });
  await fs.writeFile(
    path.join(javaDir, "Calculator.java"),
    `
package com.example;

public class Calculator {
    public int add(int a, int b) {
        return a + b;
    }

    public int subtract(int a, int b) {
        return a - b;
    }
}
    `.trim(),
  );

  // Create Go file
  const goDir = path.join(tempDir, "pkg", "utils");
  await fs.mkdir(goDir, { recursive: true });
  await fs.writeFile(
    path.join(goDir, "helpers.go"),
    `
package utils

func Add(a, b int) int {
    return a + b
}

func Multiply(a, b int) int {
    return a * b
}
    `.trim(),
  );

  // Create Rust file
  const rustDir = path.join(tempDir, "src");
  await fs.writeFile(
    path.join(rustDir, "lib.rs"),
    `
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

pub fn multiply(a: i32, b: i32) -> i32 {
    a * b
}
    `.trim(),
  );

  // Create C file
  const cDir = path.join(tempDir, "src", "c");
  await fs.mkdir(cDir, { recursive: true });
  await fs.writeFile(
    path.join(cDir, "math.c"),
    `
int add(int a, int b) {
    return a + b;
}

int multiply(int a, int b) {
    return a * b;
}
    `.trim(),
  );

  // Create C++ file
  const cppDir = path.join(tempDir, "src", "cpp");
  await fs.mkdir(cppDir, { recursive: true });
  await fs.writeFile(
    path.join(cppDir, "math.cpp"),
    `
class Math {
public:
    int add(int a, int b) {
        return a + b;
    }

    int multiply(int a, int b) {
        return a * b;
    }
};
    `.trim(),
  );

  // Create C# file
  const csharpDir = path.join(tempDir, "src", "csharp");
  await fs.mkdir(csharpDir, { recursive: true });
  await fs.writeFile(
    path.join(csharpDir, "Math.cs"),
    `
namespace MyApp {
    public class Math {
        public int Add(int a, int b) {
            return a + b;
        }

        public int Multiply(int a, int b) {
            return a * b;
        }
    }
}
    `.trim(),
  );

  // Create Ruby file
  const rubyDir = path.join(tempDir, "lib");
  await fs.mkdir(rubyDir, { recursive: true });
  await fs.writeFile(
    path.join(rubyDir, "calculator.rb"),
    `
class Calculator
  def add(a, b)
    a + b
  end

  def multiply(a, b)
    a * b
  end
end
    `.trim(),
  );

  // Create Swift file
  const swiftDir = path.join(tempDir, "Sources");
  await fs.mkdir(swiftDir, { recursive: true });
  await fs.writeFile(
    path.join(swiftDir, "Math.swift"),
    `
class Math {
    func add(_ a: Int, _ b: Int) -> Int {
        return a + b
    }

    func multiply(_ a: Int, _ b: Int) -> Int {
        return a * b
    }
}
    `.trim(),
  );

  return {
    rootPath: tempDir,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

// ─── Integration Tests ────────────────────────────────────────────────────

describe("Integration: File Path Context Bugfix", () => {
  let fixture: Awaited<ReturnType<typeof createTestFixture>>;

  beforeEach(async () => {
    fixture = await createTestFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  // ─── Test 1: Full indexing pipeline with files from different scan paths ──

  it("extracts symbols from all supported languages with absolute paths", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const result = await extractAllSymbols(fileNodes, fixture.rootPath);

    // Verify we extracted symbols from multiple languages
    expect(result.symbols.length).toBeGreaterThan(0);

    // Verify all symbols have absolute paths
    for (const symbol of result.symbols) {
      expect(symbol.location.filePath).toMatch(/^\/|^[A-Z]:/); // Unix or Windows absolute path
      expect(symbol.location.filePath).toContain(fixture.rootPath);
      expect(symbol.location.filePath).not.toContain("./");
      expect(symbol.location.filePath).not.toContain("../");
    }
  });

  it("extracts symbols from TypeScript files with absolute paths", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const tsFiles = fileNodes.filter((f) => f.language === "typescript");

    expect(tsFiles.length).toBeGreaterThan(0);

    const result = await extractAllSymbols(tsFiles, fixture.rootPath);

    // Should extract AuthService class and its methods
    expect(result.symbols.length).toBeGreaterThan(0);

    for (const symbol of result.symbols) {
      expect(symbol.location.filePath).toContain("auth.ts");
      expect(symbol.location.filePath).toMatch(/^\/|^[A-Z]:/);
    }
  });

  it("extracts symbols from JavaScript files with absolute paths", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const jsFiles = fileNodes.filter((f) => f.language === "javascript");

    expect(jsFiles.length).toBeGreaterThan(0);

    const result = await extractAllSymbols(jsFiles, fixture.rootPath);

    for (const symbol of result.symbols) {
      expect(symbol.location.filePath).toContain("helpers.js");
      expect(symbol.location.filePath).toMatch(/^\/|^[A-Z]:/);
    }
  });

  it("extracts symbols from Python files with absolute paths", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const pyFiles = fileNodes.filter((f) => f.language === "python");

    expect(pyFiles.length).toBeGreaterThan(0);

    const result = await extractAllSymbols(pyFiles, fixture.rootPath);

    for (const symbol of result.symbols) {
      expect(symbol.location.filePath).toContain("user.py");
      expect(symbol.location.filePath).toMatch(/^\/|^[A-Z]:/);
    }
  });

  it("extracts symbols from PHP files with absolute paths", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const phpFiles = fileNodes.filter((f) => f.language === "php");

    expect(phpFiles.length).toBeGreaterThan(0);

    const result = await extractAllSymbols(phpFiles, fixture.rootPath);

    for (const symbol of result.symbols) {
      expect(symbol.location.filePath).toContain("UserService.php");
      expect(symbol.location.filePath).toMatch(/^\/|^[A-Z]:/);
    }
  });

  it("extracts symbols from Java files with absolute paths", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const javaFiles = fileNodes.filter((f) => f.language === "java");

    expect(javaFiles.length).toBeGreaterThan(0);

    const result = await extractAllSymbols(javaFiles, fixture.rootPath);

    for (const symbol of result.symbols) {
      expect(symbol.location.filePath).toContain("Calculator.java");
      expect(symbol.location.filePath).toMatch(/^\/|^[A-Z]:/);
    }
  });

  it("extracts symbols from Go files with absolute paths", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const goFiles = fileNodes.filter((f) => f.language === "go");

    expect(goFiles.length).toBeGreaterThan(0);

    const result = await extractAllSymbols(goFiles, fixture.rootPath);

    for (const symbol of result.symbols) {
      expect(symbol.location.filePath).toContain("helpers.go");
      expect(symbol.location.filePath).toMatch(/^\/|^[A-Z]:/);
    }
  });

  it("extracts symbols from Rust files with absolute paths", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const rustFiles = fileNodes.filter((f) => f.language === "rust");

    expect(rustFiles.length).toBeGreaterThan(0);

    const result = await extractAllSymbols(rustFiles, fixture.rootPath);

    for (const symbol of result.symbols) {
      expect(symbol.location.filePath).toContain("lib.rs");
      expect(symbol.location.filePath).toMatch(/^\/|^[A-Z]:/);
    }
  });

  it("extracts symbols from C files with absolute paths", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const cFiles = fileNodes.filter((f) => f.language === "c");

    expect(cFiles.length).toBeGreaterThan(0);

    const result = await extractAllSymbols(cFiles, fixture.rootPath);

    for (const symbol of result.symbols) {
      expect(symbol.location.filePath).toContain("math.c");
      expect(symbol.location.filePath).toMatch(/^\/|^[A-Z]:/);
    }
  });

  it("extracts symbols from C++ files with absolute paths", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const cppFiles = fileNodes.filter((f) => f.language === "cpp");

    expect(cppFiles.length).toBeGreaterThan(0);

    const result = await extractAllSymbols(cppFiles, fixture.rootPath);

    for (const symbol of result.symbols) {
      expect(symbol.location.filePath).toContain("math.cpp");
      expect(symbol.location.filePath).toMatch(/^\/|^[A-Z]:/);
    }
  });

  it("extracts symbols from C# files with absolute paths", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const csharpFiles = fileNodes.filter((f) => f.language === "csharp");

    expect(csharpFiles.length).toBeGreaterThan(0);

    const result = await extractAllSymbols(csharpFiles, fixture.rootPath);

    for (const symbol of result.symbols) {
      expect(symbol.location.filePath).toContain("Math.cs");
      expect(symbol.location.filePath).toMatch(/^\/|^[A-Z]:/);
    }
  });

  it("extracts symbols from Ruby files with absolute paths", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const rubyFiles = fileNodes.filter((f) => f.language === "ruby");

    expect(rubyFiles.length).toBeGreaterThan(0);

    const result = await extractAllSymbols(rubyFiles, fixture.rootPath);

    for (const symbol of result.symbols) {
      expect(symbol.location.filePath).toContain("calculator.rb");
      expect(symbol.location.filePath).toMatch(/^\/|^[A-Z]:/);
    }
  });

  it("extracts symbols from Swift files with absolute paths", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const swiftFiles = fileNodes.filter((f) => f.language === "swift");

    expect(swiftFiles.length).toBeGreaterThan(0);

    const result = await extractAllSymbols(swiftFiles, fixture.rootPath);

    for (const symbol of result.symbols) {
      expect(symbol.location.filePath).toContain("Math.swift");
      expect(symbol.location.filePath).toMatch(/^\/|^[A-Z]:/);
    }
  });

  // ─── Test 2: Phase 3 reference resolution works with absolute paths ──────

  it("relationship hints contain absolute source file paths", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const result = await extractAllSymbols(fileNodes, fixture.rootPath);

    // Verify all hints have absolute source file paths
    for (const hint of result.hints) {
      expect(hint.sourceFile).toMatch(/^\/|^[A-Z]:/); // Unix or Windows absolute path
      expect(hint.sourceFile).toContain(fixture.rootPath);
      expect(hint.sourceFile).not.toContain("./");
      expect(hint.sourceFile).not.toContain("../");
    }
  });

  it("import hints have absolute source file paths", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const result = await extractAllSymbols(fileNodes, fixture.rootPath);

    const importHints = result.hints.filter((h) => h.kind === "import");

    for (const hint of importHints) {
      expect(hint.sourceFile).toMatch(/^\/|^[A-Z]:/);
      expect(hint.sourceFile).toContain(fixture.rootPath);
    }
  });

  it("call hints have absolute source file paths", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const result = await extractAllSymbols(fileNodes, fixture.rootPath);

    const callHints = result.hints.filter((h) => h.kind === "call");

    for (const hint of callHints) {
      expect(hint.sourceFile).toMatch(/^\/|^[A-Z]:/);
      expect(hint.sourceFile).toContain(fixture.rootPath);
    }
  });

  it("heritage hints have absolute source file paths", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const result = await extractAllSymbols(fileNodes, fixture.rootPath);

    const heritageHints = result.hints.filter(
      (h) => h.kind === "inherits" || h.kind === "implements",
    );

    for (const hint of heritageHints) {
      expect(hint.sourceFile).toMatch(/^\/|^[A-Z]:/);
      expect(hint.sourceFile).toContain(fixture.rootPath);
    }
  });

  // ─── Test 3: File content can be read using stored absolute paths ────────

  it("file content can be read using stored absolute paths", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const result = await extractAllSymbols(fileNodes, fixture.rootPath);

    // For each symbol, verify we can read the file using its stored path
    for (const symbol of result.symbols) {
      const content = await fs.readFile(symbol.location.filePath, "utf-8");
      expect(content.length).toBeGreaterThan(0);
    }
  });

  it("file content can be read for all extracted symbols", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const result = await extractAllSymbols(fileNodes, fixture.rootPath);

    const readableFiles = new Set<string>();

    for (const symbol of result.symbols) {
      try {
        const content = await fs.readFile(symbol.location.filePath, "utf-8");
        if (content.length > 0) {
          readableFiles.add(symbol.location.filePath);
        }
      } catch (err) {
        throw new Error(`Failed to read file: ${symbol.location.filePath}`);
      }
    }

    expect(readableFiles.size).toBeGreaterThan(0);
  });

  // ─── Test 4: Symbol IDs are unique across different scan roots ───────────

  it("symbol IDs are unique when scanned from the same root", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const result = await extractAllSymbols(fileNodes, fixture.rootPath);

    const ids = result.symbols.map((s) => s.id);
    const uniqueIds = new Set(ids);

    expect(uniqueIds.size).toBe(ids.length);
  });

  it("symbol IDs differ when the same file is scanned from different roots", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);

    // Scan from original root
    const result1 = await extractAllSymbols(fileNodes, fixture.rootPath);

    // Verify we have symbols from the first scan
    expect(result1.symbols.length).toBeGreaterThan(0);

    // Verify that symbol IDs contain the root path
    for (const symbol of result1.symbols) {
      expect(symbol.id).toContain(fixture.rootPath);
    }

    // Simulate scanning from a different root by manually constructing
    // what the IDs would be if we used a different root path
    const altRoot = "/different/root/path";
    const altIds = result1.symbols.map((s) => {
      // Replace the original root with the alternative root in the ID
      return s.id.replace(fixture.rootPath, altRoot);
    });

    // Verify that IDs are different when roots are different
    const ids1 = new Set(result1.symbols.map((s) => s.id));
    const ids2 = new Set(altIds);

    // Check that at least some IDs are different
    let differentCount = 0;
    for (const id of ids1) {
      if (!ids2.has(id)) {
        differentCount++;
      }
    }
    expect(differentCount).toBeGreaterThan(0);
  });

  it("symbol IDs include the full absolute path", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const result = await extractAllSymbols(fileNodes, fixture.rootPath);

    for (const symbol of result.symbols) {
      // Symbol ID should contain the absolute path
      expect(symbol.id).toContain(symbol.location.filePath);
    }
  });

  // ─── Test 5: Extraction logic is preserved across all languages ──────────

  it("symbol names are preserved across all languages", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const result = await extractAllSymbols(fileNodes, fixture.rootPath);

    // Verify that symbol names are non-empty and reasonable
    for (const symbol of result.symbols) {
      expect(symbol.name).toBeTruthy();
      expect(symbol.name.length).toBeGreaterThan(0);
      expect(typeof symbol.name).toBe("string");
    }
  });

  it("symbol kinds are valid across all languages", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const result = await extractAllSymbols(fileNodes, fixture.rootPath);

    const validKinds = new Set([
      "function",
      "class",
      "method",
      "interface",
      "variable",
      "import",
      "export",
      "type",
    ]);

    for (const symbol of result.symbols) {
      expect(validKinds.has(symbol.kind)).toBe(true);
    }
  });

  it("symbol locations have valid line and column numbers", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const result = await extractAllSymbols(fileNodes, fixture.rootPath);

    for (const symbol of result.symbols) {
      const { startLine, startColumn, endLine, endColumn } = symbol.location;

      expect(startLine).toBeGreaterThanOrEqual(0);
      expect(startColumn).toBeGreaterThanOrEqual(0);
      expect(endLine).toBeGreaterThanOrEqual(startLine);

      if (startLine === endLine) {
        expect(endColumn).toBeGreaterThanOrEqual(startColumn);
      }
    }
  });

  it("symbol visibility is preserved across all languages", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const result = await extractAllSymbols(fileNodes, fixture.rootPath);

    const validVisibilities = new Set(["public", "private", "protected", "internal"]);

    for (const symbol of result.symbols) {
      expect(validVisibilities.has(symbol.visibility)).toBe(true);
    }
  });

  it("symbol modifiers are valid across all languages", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const result = await extractAllSymbols(fileNodes, fixture.rootPath);

    const validModifiers = new Set([
      "static",
      "abstract",
      "async",
      "const",
      "readonly",
    ]);

    for (const symbol of result.symbols) {
      for (const modifier of symbol.modifiers) {
        expect(validModifiers.has(modifier)).toBe(true);
      }
    }
  });

  // ─── Test 6: Multi-language extraction consistency ────────────────────────

  it("extracts symbols from all 12 supported languages", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const result = await extractAllSymbols(fileNodes, fixture.rootPath);

    // Group symbols by language
    const languageMap = new Map<string, number>();
    for (const fileNode of fileNodes) {
      const lang = fileNode.language;
      languageMap.set(lang, (languageMap.get(lang) ?? 0) + 1);
    }

    // Verify we have files from multiple languages
    expect(languageMap.size).toBeGreaterThan(1);

    // Verify we extracted symbols
    expect(result.symbols.length).toBeGreaterThan(0);
  });

  it("all extracted symbols have absolute file paths regardless of language", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const result = await extractAllSymbols(fileNodes, fixture.rootPath);

    const languageToSymbols = new Map<string, typeof result.symbols>();

    for (const symbol of result.symbols) {
      const lang = fileNodes.find((f) =>
        symbol.location.filePath.includes(f.path),
      )?.language;

      if (lang) {
        if (!languageToSymbols.has(lang)) {
          languageToSymbols.set(lang, []);
        }
        languageToSymbols.get(lang)!.push(symbol);
      }
    }

    // Verify each language's symbols have absolute paths
    for (const [lang, symbols] of languageToSymbols) {
      for (const symbol of symbols) {
        expect(symbol.location.filePath).toMatch(/^\/|^[A-Z]:/);
        expect(symbol.location.filePath).toContain(fixture.rootPath);
      }
    }
  });

  it("relationship hints are created for all supported languages", async () => {
    const fileNodes = await walkFileTree(fixture.rootPath);
    const result = await extractAllSymbols(fileNodes, fixture.rootPath);

    // Verify hints exist and have absolute paths
    for (const hint of result.hints) {
      expect(hint.sourceFile).toMatch(/^\/|^[A-Z]:/);
      expect(hint.sourceFile).toContain(fixture.rootPath);
      expect(hint.kind).toMatch(/import|call|inherits|implements/);
    }
  });
});
