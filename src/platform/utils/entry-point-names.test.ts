/**
 * Wave 2 (1.1) — language-keyed entry-point name patterns, the merged lookup,
 * the back-compat overloads, test/utility-file predicates, and the
 * `EntryPointKind` classifier. Pure-data + pure-predicate assertions.
 */
import { describe, it, expect } from "vitest";
import type { Language } from "../../core/domain.js";
import {
  ENTRY_POINT_PATTERNS,
  ENTRY_POINT_PATTERNS_BY_LANGUAGE,
  MERGED_ENTRY_POINT_PATTERNS,
  UTILITY_PATTERNS,
  isEntryPointName,
  isUtilityName,
  isTestFile,
  isUtilityFile,
  inferEntryPointKind,
} from "./entry-point-names.js";

const ALL_LANGUAGES: Language[] = [
  "php", "typescript", "javascript", "python", "java",
  "go", "rust", "c", "cpp", "csharp", "ruby", "swift",
];

describe("entry-point name tables", () => {
  it("covers every Language literal in the keyed + merged tables", () => {
    for (const lang of ALL_LANGUAGES) {
      expect(ENTRY_POINT_PATTERNS_BY_LANGUAGE[lang]).toBeDefined();
      expect(MERGED_ENTRY_POINT_PATTERNS[lang]).toBeDefined();
    }
  });

  it("pre-merges universal + per-language patterns once at module load", () => {
    // Every merged entry must include all universal patterns plus the
    // language-specific ones (length = universal + lang-specific).
    for (const lang of ALL_LANGUAGES) {
      const merged = MERGED_ENTRY_POINT_PATTERNS[lang];
      const langSpecific = ENTRY_POINT_PATTERNS_BY_LANGUAGE[lang];
      expect(merged.length).toBe(ENTRY_POINT_PATTERNS.length + langSpecific.length);
      // The universal bucket is the prefix.
      expect(merged.slice(0, ENTRY_POINT_PATTERNS.length)).toEqual(ENTRY_POINT_PATTERNS);
    }
  });

  it("retains the flat ENTRY_POINT_PATTERNS back-compat export (= universal bucket)", () => {
    expect(Array.isArray(ENTRY_POINT_PATTERNS)).toBe(true);
    expect(ENTRY_POINT_PATTERNS.some((p) => p.test("main"))).toBe(true);
  });
});

describe("isEntryPointName", () => {
  it("matches a Go-specific pattern when language is supplied", () => {
    expect(isEntryPointName("ServeHTTP", "go")).toBe(true);
  });

  it("matches against universal+all when language is omitted (back-compat)", () => {
    // ServeHTTP is only in the Go bucket; the no-language overload still matches
    // via the merged-all set.
    expect(isEntryPointName("ServeHTTP")).toBe(true);
    expect(isEntryPointName("main")).toBe(true);
    expect(isEntryPointName("handleLogin")).toBe(true);
  });

  it("returns false for a plain non-entry name", () => {
    expect(isEntryPointName("formatDate")).toBe(false);
    expect(isEntryPointName("formatDate", "typescript")).toBe(false);
  });

  it("React hook pattern only matches under js/ts", () => {
    expect(isEntryPointName("useEffect", "typescript")).toBe(true);
    expect(isEntryPointName("useEffect", "go")).toBe(false);
  });
});

describe("isUtilityName / UTILITY_PATTERNS", () => {
  it("flags accessor/helper names", () => {
    expect(isUtilityName("getUser")).toBe(true);
    expect(isUtilityName("formatDate")).toBe(true);
    expect(isUtilityName("_private")).toBe(true);
    expect(isUtilityName("StringHelper")).toBe(true);
  });

  it("does not flag a genuine entry-point name", () => {
    expect(isUtilityName("handleRequest")).toBe(false);
    expect(isUtilityName("main")).toBe(false);
  });

  it("UTILITY_PATTERNS is a non-empty shared array", () => {
    expect(UTILITY_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe("isTestFile", () => {
  it.each([
    "/repo/src/foo.test.ts",
    "/repo/src/foo.spec.ts",
    "/repo/pkg/foo_test.go",
    "/repo/app/foo_test.py",
    "/repo/tests/foo.rb",
    "/repo/src/test/java/Foo.java",
    "/repo/MyTests.cs",
    "/repo/__tests__/foo.ts",
  ])("classifies %s as a test file", (p) => {
    expect(isTestFile(p)).toBe(true);
  });

  it.each([
    "/repo/src/foo.ts",
    "/repo/src/handlers/user.go",
  ])("does not classify %s as a test file", (p) => {
    expect(isTestFile(p)).toBe(false);
  });
});

describe("isUtilityFile", () => {
  it("flags utility/helper paths", () => {
    expect(isUtilityFile("/repo/src/utils/strings.ts")).toBe(true);
    expect(isUtilityFile("/repo/src/helpers.ts")).toBe(true);
    expect(isUtilityFile("/repo/lib/x.ts")).toBe(true);
    expect(isUtilityFile("/repo/app/_helpers.py")).toBe(true);
  });

  it("does not flag a normal source path", () => {
    expect(isUtilityFile("/repo/src/handlers/user.ts")).toBe(false);
  });
});

describe("inferEntryPointKind", () => {
  it("classifies a Swift lifecycle method", () => {
    expect(inferEntryPointKind("viewDidLoad", "/r/x.swift", [])).toBe("lifecycle");
  });

  it("classifies a route from path + reasons", () => {
    expect(inferEntryPointKind("getUser", "/r/pages/api/u.ts", ["framework:nextjs-api-route"])).toBe("route");
  });

  it("classifies a controller-named symbol as route", () => {
    expect(inferEntryPointKind("UserController", "/r/x.ts", [])).toBe("route");
  });

  it("classifies a test-file symbol as test", () => {
    expect(inferEntryPointKind("run", "/r/x.test.ts", [])).toBe("test");
  });

  it("classifies a task verb / jobs path as task", () => {
    expect(inferEntryPointKind("perform", "/r/x.rb", [])).toBe("task");
    expect(inferEntryPointKind("doWork", "/r/jobs/x.ts", [])).toBe("task");
  });

  it("classifies an event handler as event", () => {
    expect(inferEntryPointKind("onClick", "/r/x.ts", [])).toBe("event");
  });

  it("defaults to main", () => {
    expect(inferEntryPointKind("init", "/r/x.ts", [])).toBe("main");
  });
});
