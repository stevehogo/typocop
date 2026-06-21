/**
 * Wave 1 — per-resolver unit tests (pure functions over an in-memory file set).
 *
 * Covers: suffix index (exact / case-insensitive / longest-wins ambiguity),
 * `tryResolveWithExtensions`, `suffixResolve`, `resolveImportPath` (relative,
 * alias, Python PEP-328, cache hit/eviction), Go package dir + members, PHP
 * PSR-4 + suffix fallback, Java member/wildcard, and the dispatch (TS files /
 * Go package / null external / PHP / Java).
 */
import { describe, it, expect } from "vitest";
import type { Language } from "../../../../core/domain.js";
import type { LanguageConfigs, TsconfigPaths } from "../../language-config.js";
import {
  EXTENSIONS,
  buildSuffixIndex,
  suffixResolve,
  tryResolveWithExtensions,
} from "./utils.js";
import { resolveImportPath, RESOLVE_CACHE_CAP } from "./standard.js";
import { resolveGoPackage, resolveGoPackageDir } from "./go.js";
import { resolvePhpImport } from "./php.js";
import { resolveJvmMemberImport, resolveJvmWildcard } from "./jvm.js";
import {
  buildImportResolutionContext,
  resolveImportSpecifier,
  type ResolveCtx,
} from "./dispatch.js";
import { isFileInPackageDir } from "../named-binding.js";

function index(files: string[]) {
  const normalized = files.map((f) => f.replace(/\\/g, "/"));
  return buildSuffixIndex(normalized, files);
}

function ctxFor(files: string[]): ResolveCtx {
  const c = buildImportResolutionContext(files);
  return {
    allFilePaths: c.allFilePaths,
    allFileList: c.allFileList,
    normalizedFileList: c.normalizedFileList,
    index: c.suffixIndex,
    resolveCache: c.resolveCache,
  };
}

const emptyConfigs: LanguageConfigs = {
  tsconfig: null,
  composer: null,
  goModule: null,
  csharp: [],
  swift: null,
};

describe("EXTENSIONS table", () => {
  it("starts with the empty extension and includes the TS/Python/Go/PHP/Java ones", () => {
    expect(EXTENSIONS[0]).toBe("");
    for (const e of [".ts", ".tsx", ".jsx", ".py", "/__init__.py", ".java", ".go", ".php", "/index.ts"]) {
      expect(EXTENSIONS).toContain(e);
    }
  });
});

describe("buildSuffixIndex + suffixResolve", () => {
  const files = ["src/com/example/Foo.java", "src/models.ts", "lib/com/example/Foo.java"];
  const idx = index(files);

  it("exact suffix lookup, first/longest write wins for ambiguous suffix", () => {
    // "Foo.java" appears in two files; first inserted (src/...) wins.
    expect(idx.get("Foo.java")).toBe("src/com/example/Foo.java");
    expect(idx.get("example/Foo.java")).toBe("src/com/example/Foo.java");
    expect(idx.get("com/example/Foo.java")).toBe("src/com/example/Foo.java");
  });

  it("case-insensitive lookup", () => {
    expect(idx.getInsensitive("foo.java")).toBe("src/com/example/Foo.java");
  });

  it("getFilesInDir lists direct members", () => {
    const members = idx.getFilesInDir("com/example", ".java");
    expect(members).toContain("src/com/example/Foo.java");
    expect(members).toContain("lib/com/example/Foo.java");
  });

  it("suffixResolve walks from most-qualified suffix down", () => {
    expect(suffixResolve(["com", "example", "Foo"], files.map((f) => f), files, idx)).toBe(
      "src/com/example/Foo.java",
    );
  });

  it("suffixResolve linear fallback (no index) finds an endsWith match", () => {
    const normalized = files.map((f) => f);
    expect(suffixResolve(["models"], normalized, files)).toBe("src/models.ts");
  });
});

describe("tryResolveWithExtensions", () => {
  it("appends extensions in order, returning the first present", () => {
    const set = new Set(["src/a/index.ts", "src/b.tsx"]);
    expect(tryResolveWithExtensions("src/b", set)).toBe("src/b.tsx");
    expect(tryResolveWithExtensions("src/a", set)).toBe("src/a/index.ts");
    expect(tryResolveWithExtensions("src/missing", set)).toBeNull();
  });
});

describe("resolveImportPath — relative + alias + python", () => {
  const files = ["src/index.ts", "src/models.ts", "src/a/b.ts", "src/foo.ts", "pkg/mod.py", "pkg/sub/models.py"];
  const set = new Set(files);
  const norm = files.map((f) => f);
  const idx = index(files);

  function run(currentFile: string, importPath: string, lang: Language, tsconfig: TsconfigPaths | null) {
    return resolveImportPath(currentFile, importPath, set, files, norm, new Map(), lang, tsconfig, idx);
  }

  it("./models → src/models.ts", () => {
    expect(run("src/index.ts", "./models", "typescript", null)).toBe("src/models.ts");
  });

  it("../a/b from a sibling → src/a/b.ts", () => {
    expect(run("src/x/y.ts", "../a/b", "typescript", null)).toBe("src/a/b.ts");
  });

  it("@/foo alias (baseUrl='.') → src/foo.ts", () => {
    const tsconfig: TsconfigPaths = { aliases: new Map([["@/", "src/"]]), baseUrl: "." };
    expect(run("src/index.ts", "@/foo", "typescript", tsconfig)).toBe("src/foo.ts");
  });

  it("python .models relative from a package file", () => {
    expect(run("pkg/sub/handler.py", ".models", "python", null)).toBe("pkg/sub/models.py");
  });

  it("python ..mod (parent package) relative", () => {
    expect(run("pkg/sub/handler.py", "..mod", "python", null)).toBe("pkg/mod.py");
  });

  it("bare external specifier → null", () => {
    expect(run("src/index.ts", "react", "typescript", null)).toBeNull();
  });
});

describe("resolveImportPath — cache hit + LRU eviction", () => {
  it("cache hit returns identical result without recomputing", () => {
    const files = ["src/models.ts"];
    const cache = new Map<string, string | null>();
    const first = resolveImportPath("src/a.ts", "./models", new Set(files), files, files, cache, "typescript", null, index(files));
    expect(first).toBe("src/models.ts");
    // Poison the file set: a cached lookup must NOT re-resolve.
    const second = resolveImportPath("src/a.ts", "./models", new Set<string>(), [], [], cache, "typescript", null, index([]));
    expect(second).toBe("src/models.ts");
  });

  it("evicts the oldest 20% when the cap is exceeded", () => {
    const cache = new Map<string, string | null>();
    // Pre-fill above the cap with synthetic entries (insertion order = FIFO).
    for (let i = 0; i < RESOLVE_CACHE_CAP; i++) cache.set(`k${i}::x`, null);
    expect(cache.size).toBe(RESOLVE_CACHE_CAP);
    // One more resolve triggers eviction of the oldest 20% then inserts the new key.
    resolveImportPath("new.ts", "./z", new Set(["new.ts"]), ["new.ts"], ["new.ts"], cache, "typescript", null);
    const evicted = Math.floor(RESOLVE_CACHE_CAP * 0.2);
    expect(cache.size).toBe(RESOLVE_CACHE_CAP - evicted + 1);
    expect(cache.has("k0::x")).toBe(false); // oldest evicted
  });
});

describe("Go resolver", () => {
  const goModule = { modulePath: "github.com/org/repo" };
  const files = [
    "internal/auth/service.go",
    "internal/auth/service_test.go",
    "internal/auth/handler.go",
    "internal/auth/sub/deep.go",
    "cmd/main.go",
  ];
  const norm = files.map((f) => f);

  it("resolveGoPackageDir returns the trailing package directory segment", () => {
    expect(resolveGoPackageDir("github.com/org/repo/internal/auth", goModule)).toBe("auth");
    expect(resolveGoPackageDir("github.com/other/x", goModule)).toBeNull();
  });

  it("resolveGoPackage returns direct .go members, excluding _test.go and subdirs", () => {
    const members = resolveGoPackage("github.com/org/repo/internal/auth", goModule, norm, files);
    expect(members).toEqual(["internal/auth/service.go", "internal/auth/handler.go"]);
  });

  it("Go dir-suffix round-trips through typocop's isFileInPackageDir (nested package)", () => {
    const suffix = resolveGoPackageDir("github.com/org/repo/internal/auth", goModule)!;
    // The member files contain the suffix as an interior path segment.
    expect(isFileInPackageDir("internal/auth/service.go", suffix)).toBe(true);
    expect(isFileInPackageDir("internal/auth/handler.go", suffix)).toBe(true);
    // A file outside the package does not match.
    expect(isFileInPackageDir("cmd/main.go", suffix)).toBe(false);
  });
});

describe("PHP resolver", () => {
  const files = ["app/Http/Controllers/UserController.php", "app/Models/User.php", "src/Lib/Helper.php"];
  const norm = files.map((f) => f);
  const idx = index(files);

  it("PSR-4 longest-prefix → file path", () => {
    const composer = { psr4: new Map([["App\\", "app"]]) };
    expect(
      resolvePhpImport("App\\Http\\Controllers\\UserController", composer, new Set(files), norm, files, idx),
    ).toBe("app/Http/Controllers/UserController.php");
  });

  it("suffix fallback when no composer config", () => {
    expect(resolvePhpImport("Lib\\Helper", null, new Set(files), norm, files, idx)).toBe("src/Lib/Helper.php");
  });
});

describe("Java JVM resolver", () => {
  const files = ["src/com/example/Foo.java", "src/com/example/Bar.java", "src/com/example/sub/Deep.java"];
  const norm = files.map((f) => f);
  const idx = index(files);

  it("member import com.example.Foo → …/Foo.java", () => {
    // grapuco treats a lowercase/ALL_CAPS last segment as a member; a class
    // import like com.example.Foo.method strips to com.example.Foo.
    expect(resolveJvmMemberImport("com.example.Foo.method", norm, files, idx)).toBe("src/com/example/Foo.java");
  });

  it("wildcard com.example.* → direct .java members only", () => {
    const matched = resolveJvmWildcard("com.example.*", norm, files, idx);
    expect(matched).toContain("src/com/example/Foo.java");
    expect(matched).toContain("src/com/example/Bar.java");
    expect(matched).not.toContain("src/com/example/sub/Deep.java");
  });
});

describe("resolveImportSpecifier dispatch", () => {
  it("Go module import → kind:'package'", () => {
    const files = ["internal/auth/service.go"];
    const configs: LanguageConfigs = { ...emptyConfigs, goModule: { modulePath: "github.com/org/repo" } };
    const r = resolveImportSpecifier("cmd/main.go", "github.com/org/repo/internal/auth", "go", configs, ctxFor(files));
    expect(r?.kind).toBe("package");
    if (r?.kind === "package") {
      expect(r.dirSuffix).toBe("auth");
      expect(r.files).toEqual(["internal/auth/service.go"]);
    }
  });

  it("relative TS import → kind:'files' len 1", () => {
    const files = ["src/models.ts", "src/index.ts"];
    const r = resolveImportSpecifier("src/index.ts", "./models", "typescript", emptyConfigs, ctxFor(files));
    expect(r).toEqual({ kind: "files", files: ["src/models.ts"] });
  });

  it("external bare specifier → null", () => {
    const files = ["src/index.ts"];
    expect(resolveImportSpecifier("src/index.ts", "react", "typescript", emptyConfigs, ctxFor(files))).toBeNull();
    expect(resolveImportSpecifier("src/index.ts", "lodash", "javascript", emptyConfigs, ctxFor(files))).toBeNull();
  });

  it("PHP routed via resolvePhpImport (suffix fallback)", () => {
    const files = ["src/Lib/Helper.php"];
    const r = resolveImportSpecifier("src/App.php", "Lib\\Helper", "php", emptyConfigs, ctxFor(files));
    expect(r).toEqual({ kind: "files", files: ["src/Lib/Helper.php"] });
  });

  it("Java routed via member import", () => {
    const files = ["src/com/example/Foo.java"];
    const r = resolveImportSpecifier("src/com/example/App.java", "com.example.Foo", "java", emptyConfigs, ctxFor(files));
    // com.example.Foo: last segment "Foo" is uppercase-leading → not a member,
    // so member import returns null and it falls through to suffix resolution.
    expect(r).toEqual({ kind: "files", files: ["src/com/example/Foo.java"] });
  });
});
