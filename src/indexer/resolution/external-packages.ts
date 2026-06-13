import type {
  ExternalDependencyNode,
  Language,
  PackageEcosystem,
} from "../../types/index.js";
import { C_SYSTEM_HEADERS, GO_VCS_HOSTS } from "../../utils/limits.js";

function trimImportPath(importPath: string): string {
  return importPath.trim().replace(/^["'<]+|[">']+$/g, "");
}

function stripTrailingSeparators(value: string): string {
  return value.replace(/[./\\:]+$/g, "");
}

function splitBarePath(importPath: string, separator: "/" | "\\" | "::" | "."): string[] {
  return importPath.split(separator).map((part) => part.trim()).filter(Boolean);
}

function toCamelCase(value: string): string {
  const parts = value.split(/[-_.\\/:\s]+/).filter(Boolean);
  if (parts.length === 0) return value;
  return parts[0].toLowerCase() + parts.slice(1)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}

function toPascalCase(value: string): string {
  return value.split(/[-_.\\/:\s]+/).filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}

function stripAliases(value: string): string {
  return value.replace(/[-_.\\/:\s]/g, "");
}

function normalizeCHeader(importPath: string): string {
  const trimmed = trimImportPath(importPath);
  const noExt = trimmed.replace(/\.[^.]+$/, "");
  const [root] = splitBarePath(noExt, "/");
  return stripTrailingSeparators(root ?? noExt);
}

export function isExternalPackage(importPath: string, language: Language): boolean {
  const trimmed = trimImportPath(importPath);
  if (trimmed.length === 0) return false;
  if (
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith(".\\") ||
    trimmed.startsWith("..\\")
  ) {
    return false;
  }
  if (trimmed.startsWith("node:")) return false;
  if (language === "rust" && /^(crate|super|self)::/.test(trimmed)) return false;
  if ((language === "c" || language === "cpp") && C_SYSTEM_HEADERS.has(trimmed)) return false;
  return true;
}

export function normalizePackageName(importPath: string, language: Language): string {
  const trimmed = trimImportPath(importPath);
  if (trimmed.length === 0) return "unknown";
  switch (language) {
    case "php": {
      const [vendor] = splitBarePath(trimmed, "\\");
      return stripTrailingSeparators(vendor ?? trimmed);
    }
    case "java":
    case "csharp": {
      const segments = splitBarePath(trimmed, ".");
      return stripTrailingSeparators(segments.slice(0, Math.min(2, segments.length)).join(".") || trimmed);
    }
    case "go": {
      const segments = splitBarePath(trimmed, "/");
      const rootLength = GO_VCS_HOSTS.has(segments[0] ?? "") ? 3 : Math.min(3, segments.length);
      return stripTrailingSeparators(segments.slice(0, rootLength).join("/") || trimmed);
    }
    case "rust": {
      const [crateName] = splitBarePath(trimmed, "::");
      return stripTrailingSeparators(crateName ?? trimmed);
    }
    case "c":
    case "cpp":
      return normalizeCHeader(trimmed);
    case "typescript":
    case "javascript": {
      if (trimmed.startsWith("@")) {
        const segments = splitBarePath(trimmed, "/");
        return stripTrailingSeparators(segments.slice(0, Math.min(2, segments.length)).join("/"));
      }
      const [pkg] = splitBarePath(trimmed, "/");
      return stripTrailingSeparators(pkg ?? trimmed);
    }
    default: {
      const [pkg] = splitBarePath(trimmed, "/");
      return stripTrailingSeparators(pkg ?? trimmed);
    }
  }
}

export function buildAliases(packageName: string): readonly string[] {
  const aliases = new Set<string>([packageName]);
  const camel = toCamelCase(packageName);
  const pascal = toPascalCase(packageName);
  const stripped = stripAliases(packageName);
  if (camel) aliases.add(camel);
  if (pascal) aliases.add(pascal);
  if (stripped) aliases.add(stripped);
  return [...aliases];
}

export function detectEcosystem(language: Language): PackageEcosystem {
  switch (language) {
    case "typescript":
    case "javascript":
      return "npm";
    case "php":
      return "composer";
    case "python":
      return "pip";
    case "java":
      return "maven";
    case "rust":
      return "cargo";
    case "go":
      return "go_modules";
    default:
      return "unknown";
  }
}

export function getOrCreateExtNode(
  packageName: string,
  language: Language,
  extNodes: Map<string, ExternalDependencyNode>,
): ExternalDependencyNode {
  const normalizedName = normalizePackageName(packageName, language);
  const id = `ext:${normalizedName}`;
  const existing = extNodes.get(id);
  if (existing) return existing;

  const created: ExternalDependencyNode = {
    id,
    name: normalizedName,
    aliases: buildAliases(normalizedName),
    ecosystem: detectEcosystem(language),
  };
  extNodes.set(id, created);
  return created;
}
