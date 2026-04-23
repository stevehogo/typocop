import { describe, it, expect } from "vitest";
import {
  sourcePathToVaultPath,
  slugify,
  renderSymbolFile,
  renderVault,
} from "./renderer.js";
import { renderProcessFile, renderClusterFile, renderNavigationIndex } from "./render-cluster-process.js";
import type { GraphData, ExportedSymbol, ExportedProcessStep, ExportedProcess, ExportedCluster } from "./graph-reader.js";
import type { SymbolRenderContext } from "./render-symbol.js";

// --- Factories ---

function getMockSymbol(overrides?: Partial<ExportedSymbol>): ExportedSymbol {
  return {
    id: "sym-1",
    name: "parseArgs",
    kind: "function",
    filePath: "src/cli/parser.ts",
    startLine: 10,
    endLine: 50,
    visibility: "public",
    signature: "parseArgs(args: string[]): Command",
    documentation: "",
    ...overrides,
  };
}

function getMockContext(overrides?: Partial<SymbolRenderContext>): SymbolRenderContext {
  return {
    symbolToCluster: new Map([["sym-1", "cli-infrastructure"]]),
    callerCounts: new Map([["sym-1", 2]]),
    outgoingCalls: new Map([["sym-1", ["executeCLI", "detectLanguage"]]]),
    incomingCalls: new Map([["sym-1", ["main"]]]),
    ...overrides,
  };
}

function getMockProcess(overrides?: Partial<ExportedProcess>): ExportedProcess {
  return {
    id: "proc-1",
    name: "User Login Flow",
    entryPoint: "handleLogin",
    stepCount: 3,
    ...overrides,
  };
}

function getMockSteps(): ExportedProcessStep[] {
  return [
    { order: 0, symbolId: "s1", symbolName: "handleLogin" },
    { order: 1, symbolId: "s2", symbolName: "authenticateUser" },
    { order: 2, symbolId: "s3", symbolName: "generateToken" },
  ];
}

// --- 7.1: sourcePathToVaultPath ---

describe("sourcePathToVaultPath", () => {
  it("converts .ts extension to .md", () => {
    expect(sourcePathToVaultPath("src/cli/parser.ts")).toBe("src/cli/parser.md");
  });

  it("converts .js extension to .md", () => {
    expect(sourcePathToVaultPath("src/index.js")).toBe("src/index.md");
  });

  it("converts .py extension to .md", () => {
    expect(sourcePathToVaultPath("app/models/user.py")).toBe("app/models/user.md");
  });

  it("converts .go extension to .md", () => {
    expect(sourcePathToVaultPath("main.go")).toBe("main.md");
  });

  it("handles deeply nested paths", () => {
    expect(sourcePathToVaultPath("src/deep/nested/path/file.tsx")).toBe("src/deep/nested/path/file.md");
  });

  it("replaces only the last extension for files with multiple dots", () => {
    expect(sourcePathToVaultPath("src/file.test.ts")).toBe("src/file.test.md");
  });

  it("strips leading slash from absolute paths", () => {
    expect(sourcePathToVaultPath("/home/user/project/src/app/page.tsx")).toBe("home/user/project/src/app/page.md");
  });
});

// --- 7.2: slugify ---

describe("slugify", () => {
  it("lowercases input", () => {
    expect(slugify("Authentication")).toBe("authentication");
  });

  it("replaces spaces with hyphens", () => {
    expect(slugify("User Login Flow")).toBe("user-login-flow");
  });

  it("preserves already-slugified strings", () => {
    expect(slugify("data-access")).toBe("data-access");
  });

  it("strips special characters and collapses separators", () => {
    expect(slugify("Special!@#Characters")).toBe("special-characters");
  });

  it("returns empty string for empty input", () => {
    expect(slugify("")).toBe("");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugify("---leading-trailing---")).toBe("leading-trailing");
  });

  it("strips non-ascii characters", () => {
    expect(slugify("café")).toBe("caf");
  });
});

// --- 7.3: renderSymbolFile ---

describe("renderSymbolFile", () => {
  it("starts with YAML frontmatter delimiters", () => {
    const symbol = getMockSymbol();
    const ctx = getMockContext();
    const output = renderSymbolFile(symbol.filePath, [symbol], ctx);
    expect(output.startsWith("---\n")).toBe(true);
  });

  it("includes source_file in frontmatter", () => {
    const symbol = getMockSymbol();
    const ctx = getMockContext();
    const output = renderSymbolFile(symbol.filePath, [symbol], ctx);
    expect(output).toContain("source_file: src/cli/parser.ts");
  });

  it("includes symbol_count in frontmatter", () => {
    const symbol = getMockSymbol();
    const ctx = getMockContext();
    const output = renderSymbolFile(symbol.filePath, [symbol], ctx);
    expect(output).toContain("symbol_count: 1");
  });

  it("renders outgoing calls as wikilinks", () => {
    const symbol = getMockSymbol();
    const ctx = getMockContext();
    const output = renderSymbolFile(symbol.filePath, [symbol], ctx);
    expect(output).toContain("**Calls**: [[executeCLI]], [[detectLanguage]]");
  });

  it("renders incoming calls as wikilinks", () => {
    const symbol = getMockSymbol();
    const ctx = getMockContext();
    const output = renderSymbolFile(symbol.filePath, [symbol], ctx);
    expect(output).toContain("**Called by**: [[main]]");
  });
});

// --- 7.3b: renderClusterFile ---

describe("renderClusterFile", () => {
  it("links members using cluster-based symbol paths", () => {
    const cluster: ExportedCluster = { id: "c1", name: "cli-infrastructure", category: "utility", confidence: 0.9, symbolCount: 1 };
    const members: ExportedSymbol[] = [getMockSymbol({ id: "s1", name: "parseArgs" })];
    const output = renderClusterFile(cluster, members);
    expect(output).toContain("[[03-symbols/cli-infrastructure/parseargs|parseArgs]]");
  });

  it("includes cluster metadata in frontmatter", () => {
    const cluster: ExportedCluster = { id: "c1", name: "core", category: "utility", confidence: 0.85, symbolCount: 3 };
    const output = renderClusterFile(cluster, []);
    expect(output).toContain("type: cluster");
    expect(output).toContain("category: utility");
    expect(output).toContain("confidence: 0.85");
  });
});

// --- 7.3c: renderNavigationIndex ---

describe("renderNavigationIndex", () => {
  it("links to cluster and process indexes with new paths", () => {
    const data: GraphData = {
      symbols: [],
      clusters: [],
      processes: [],
      relationships: [],
      clusterMemberships: new Map(),
      processSteps: new Map(),
    };
    const output = renderNavigationIndex(data);
    expect(output).toContain("[[01-clusters/_index|Clusters]]");
    expect(output).toContain("[[02-processes/_index|Processes]]");
    expect(output).toContain("[[03-symbols|Symbols]]");
  });

  it("includes usage instructions", () => {
    const data: GraphData = {
      symbols: [],
      clusters: [],
      processes: [],
      relationships: [],
      clusterMemberships: new Map(),
      processSteps: new Map(),
    };
    const output = renderNavigationIndex(data);
    expect(output).toContain("How to Use This Vault");
    expect(output).toContain("Graph View");
  });
});

// --- 7.4: renderProcessFile ---

describe("renderProcessFile", () => {
  it("contains a Mermaid code block", () => {
    const process = getMockProcess();
    const steps = getMockSteps();
    const output = renderProcessFile(process, steps);
    expect(output).toContain("```mermaid");
  });

  it("uses graph LR direction", () => {
    const process = getMockProcess();
    const steps = getMockSteps();
    const output = renderProcessFile(process, steps);
    expect(output).toContain("graph LR");
  });

  it("contains Mermaid arrows", () => {
    const process = getMockProcess();
    const steps = getMockSteps();
    const output = renderProcessFile(process, steps);
    expect(output).toContain("-->");
  });

  it("lists steps with wikilinks", () => {
    const process = getMockProcess();
    const steps = getMockSteps();
    const output = renderProcessFile(process, steps);
    expect(output).toContain("[[handleLogin]]");
    expect(output).toContain("[[authenticateUser]]");
    expect(output).toContain("[[generateToken]]");
  });
});

// --- 7.5: renderVault structure ---

describe("renderVault", () => {
  function buildTestData(): GraphData {
    const symbols: ExportedSymbol[] = [
      getMockSymbol({ id: "s1", name: "foo", filePath: "src/a.ts" }),
      getMockSymbol({ id: "s2", name: "bar", filePath: "src/a.ts" }),
      getMockSymbol({ id: "s3", name: "baz", filePath: "src/b.ts" }),
    ];

    return {
      symbols,
      clusters: [{ id: "c1", name: "core", category: "utility", confidence: 0.9, symbolCount: 2 }],
      processes: [{ id: "p1", name: "Main Flow", entryPoint: "foo", stepCount: 2 }],
      relationships: [],
      clusterMemberships: new Map([["c1", ["s1", "s2"]]]),
      processSteps: new Map([["p1", [{ order: 0, symbolId: "s1", symbolName: "foo" }, { order: 1, symbolId: "s3", symbolName: "baz" }]]]),
    };
  }

  it("produces no duplicate relativePath values", () => {
    const vault = renderVault(buildTestData());
    const paths = vault.files.map((f) => f.relativePath);
    const uniquePaths = new Set(paths);
    expect(paths.length).toBe(uniquePaths.size);
  });

  it("places symbol files under 03-symbols/{cluster-slug}/", () => {
    const vault = renderVault(buildTestData());
    const symbolFiles = vault.files.filter((f) => f.relativePath.startsWith("03-symbols/"));
    expect(symbolFiles.length).toBeGreaterThan(0);
    // Clustered symbols go under their cluster slug
    expect(symbolFiles.some((f) => f.relativePath.startsWith("03-symbols/core/"))).toBe(true);
  });

  it("places unclustered symbols under 03-symbols/unclustered/", () => {
    const vault = renderVault(buildTestData());
    // s3 (baz) is not in any cluster
    const unclustered = vault.files.filter((f) => f.relativePath.startsWith("03-symbols/unclustered/"));
    expect(unclustered.length).toBe(1);
    expect(unclustered[0].relativePath).toBe("03-symbols/unclustered/baz.md");
  });

  it("places cluster files under 01-clusters/", () => {
    const vault = renderVault(buildTestData());
    const clusterFiles = vault.files.filter((f) => f.relativePath.startsWith("01-clusters/"));
    expect(clusterFiles.some((f) => f.relativePath === "01-clusters/core.md")).toBe(true);
    expect(clusterFiles.some((f) => f.relativePath === "01-clusters/_index.md")).toBe(true);
  });

  it("places process files under 02-processes/", () => {
    const vault = renderVault(buildTestData());
    const processFiles = vault.files.filter((f) => f.relativePath.startsWith("02-processes/"));
    expect(processFiles.some((f) => f.relativePath === "02-processes/main-flow.md")).toBe(true);
    expect(processFiles.some((f) => f.relativePath === "02-processes/_index.md")).toBe(true);
  });

  it("generates a top-level _index.md navigation file", () => {
    const vault = renderVault(buildTestData());
    const nav = vault.files.find((f) => f.relativePath === "_index.md");
    expect(nav).toBeDefined();
    expect(nav!.content).toContain("Code Graph Navigator");
  });
});
