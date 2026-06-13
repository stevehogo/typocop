import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import type { Language, Symbol } from "../../../core/domain.js";
import { C_SYSTEM_HEADERS } from "../../../platform/utils/limits.js";
import {
  buildAliases,
  detectEcosystem,
  getOrCreateExtNode,
  isExternalPackage,
  normalizePackageName,
} from "./external-packages.js";
import { resolveHints } from "./index.js";

function makeSymbol(id: string, filePath: string): Symbol {
  return {
    id,
    name: id,
    kind: "function",
    location: {
      filePath,
      startLine: 1,
      startColumn: 0,
      endLine: 5,
      endColumn: 0,
    },
    visibility: "public",
    modifiers: [],
  };
}

describe("external-packages", () => {
  it("EDI-P1: bare specifiers are external for TypeScript", () => {
    fc.assert(fc.property(
      fc.stringMatching(/[A-Za-z0-9@_-]+/).filter((value) =>
        !value.startsWith("./") &&
        !value.startsWith("../") &&
        !value.startsWith("node:") &&
        !value.includes("/")
      ),
      (specifier) => isExternalPackage(specifier, "typescript"),
    ));
  });

  it("EDI-P2: relative paths are never external", () => {
    fc.assert(fc.property(
      fc.constantFrom<Language>("typescript", "javascript", "php", "python", "java", "go", "rust", "ruby"),
      fc.oneof(fc.string().map((value) => `./${value}`), fc.string().map((value) => `../${value}`)),
      (language, specifier) => !isExternalPackage(specifier, language),
    ));
  });

  it("EDI-P3: node built-ins are never external", () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1 }).map((value) => `node:${value}`),
      (specifier) => !isExternalPackage(specifier, "typescript"),
    ));
  });

  it("EDI-P4: PHP backslash paths are external", () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1 }).map((value) => `Vendor\\${value}`),
      (specifier) => isExternalPackage(specifier, "php"),
    ));
  });

  it("EDI-P5: C system headers are never external", () => {
    expect([...C_SYSTEM_HEADERS].every((header) => !isExternalPackage(header, "c"))).toBe(true);
  });

  it("EDI-P6: Rust crate/super/self imports are never external", () => {
    fc.assert(fc.property(
      fc.oneof(
        fc.string().map((value) => `crate::${value}`),
        fc.string().map((value) => `super::${value}`),
        fc.string().map((value) => `self::${value}`),
      ),
      (specifier) => !isExternalPackage(specifier, "rust"),
    ));
  });

  it("EDI-P7: normalized names have no trailing separators", () => {
    fc.assert(fc.property(
      fc.constantFrom<Language>("typescript", "php", "java", "rust", "go", "python"),
      fc.stringMatching(/[A-Za-z0-9@/_\\.-]+/).filter((value) => !value.startsWith(".") && /[A-Za-z0-9]/.test(value)),
      (language, specifier) => {
        const normalized = normalizePackageName(specifier, language);
        return normalized.length > 0 && !/[./\\:]$/.test(normalized);
      },
    ));
  });

  it("EDI-P8: aliases include canonical name", () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1 }),
      (name) => buildAliases(name).includes(name),
    ));
  });

  it("EDI-P9: IDs are stable and deterministic", () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1 }).filter((value) => !value.startsWith(".")),
      fc.constantFrom<Language>("typescript", "php", "java", "rust"),
      (name, language) => {
        const left = getOrCreateExtNode(name, language, new Map());
        const right = getOrCreateExtNode(name, language, new Map());
        return left.id === right.id && left.id === `ext:${normalizePackageName(name, language)}`;
      },
    ));
  });

  it("EDI-P11: ecosystem is always valid", () => {
    const valid = new Set(["npm", "composer", "pip", "maven", "cargo", "go_modules", "unknown"]);
    fc.assert(fc.property(
      fc.constantFrom<Language>("typescript", "php", "python", "java", "rust", "go", "c", "swift", "ruby"),
      (language) => valid.has(detectEcosystem(language)),
    ));
  });

  it("EDI-P12: internal import hints do not produce dependsOn", () => {
    fc.assert(fc.property(
      fc.array(fc.oneof(fc.string().map((value) => `./${value}`), fc.string().map((value) => `../${value}`)), {
        minLength: 1,
        maxLength: 5,
      }),
      (specifiers) => {
        const filePath = "/repo/src/example.ts";
        const symbols = [makeSymbol("sym-1", filePath)];
        const result = resolveHints(
          specifiers.map((specifier, index) => ({
            kind: "import" as const,
            sourceFile: filePath,
            targetName: specifier,
            startLine: index + 1,
            language: "typescript" as const,
          })),
          symbols,
        );
        return result.relationships.every((relationship) => relationship.relType !== "dependsOn");
      },
    ));
  });

  it("EDI-P13: dependsOn targets always use ext: ids", () => {
    fc.assert(fc.property(
      fc.array(fc.string({ minLength: 1 }).filter((value) => !value.startsWith(".")), {
        minLength: 1,
        maxLength: 5,
      }),
      (specifiers) => {
        const filePath = "/repo/src/example.ts";
        const symbols = [makeSymbol("sym-1", filePath)];
        const result = resolveHints(
          specifiers.map((specifier, index) => ({
            kind: "import" as const,
            sourceFile: filePath,
            targetName: specifier,
            startLine: index + 1,
            language: "typescript" as const,
          })),
          symbols,
        );
        return result.relationships
          .filter((relationship) => relationship.relType === "dependsOn")
          .every((relationship) => relationship.target.startsWith("ext:"));
      },
    ));
  });
});
