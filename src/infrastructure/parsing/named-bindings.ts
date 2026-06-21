/**
 * Named-import binding extraction (Wave 1, Phase 2 / infrastructure layer).
 *
 * Ported from the legacy parser's `ingestion/named-binding-extraction.ts`,
 * restricted to the in-scope languages TS/JS, Python, Java. These are AST-node
 * walkers (`namedChildren`, `childForFieldName`), so they live in the
 * infrastructure parsing layer (next to `extract-symbols.ts`), NOT in the pure
 * application sub-pass.
 *
 * Each extractor returns `{ local, exported }[]` where `local` is the name
 * visible in the importing file and `exported` is the original name in the
 * source file (so `import { Foo as Bar }` → `{ local: 'Bar', exported: 'Foo' }`).
 * Returns `undefined` for default / namespace / wildcard / side-effect imports
 * (no false entries).
 *
 * ── Wave 7 seam ──: the legacy parser also has extractors for Kotlin / Rust / PHP / C#.
 * They are intentionally NOT ported here (PHP path resolution ships this wave,
 * but PHP *named* bindings can wait — the maps still get file-level Tier-2a
 * coverage without them). Kotlin has no typocop `Language` member.
 */
import type Parser from "tree-sitter";
import type { Language } from "../../core/domain.js";

type Binding = { local: string; exported: string };

/** First named child of the given type, or null. */
function findChild(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child.type === type) return child;
  }
  return null;
}

/**
 * Extract named bindings from an import AST node, dispatched by language.
 * Returns `undefined` when the import yields no named bindings.
 */
export function extractNamedBindings(
  importNode: Parser.SyntaxNode,
  language: Language,
): Binding[] | undefined {
  if (language === "typescript" || language === "javascript") {
    return extractTsNamedBindings(importNode);
  }
  if (language === "python") {
    return extractPythonNamedBindings(importNode);
  }
  if (language === "java") {
    return extractJavaNamedBindings(importNode);
  }
  // Wave 7: php / csharp / rust (+ kotlin if the union gains it).
  return undefined;
}

export function extractTsNamedBindings(importNode: Parser.SyntaxNode): Binding[] | undefined {
  // import_statement > import_clause > named_imports > import_specifier*
  const importClause = findChild(importNode, "import_clause");
  if (importClause) {
    const namedImports = findChild(importClause, "named_imports");
    if (!namedImports) return undefined; // default / namespace / side-effect

    const bindings: Binding[] = [];
    for (const specifier of namedImports.namedChildren) {
      if (specifier.type !== "import_specifier") continue;

      const identifiers: string[] = [];
      for (const child of specifier.namedChildren) {
        if (child.type === "identifier") identifiers.push(child.text);
      }

      if (identifiers.length === 1) {
        bindings.push({ local: identifiers[0], exported: identifiers[0] });
      } else if (identifiers.length === 2) {
        // import { Foo as Bar } → exported='Foo', local='Bar'
        bindings.push({ local: identifiers[1], exported: identifiers[0] });
      }
    }
    return bindings.length > 0 ? bindings : undefined;
  }

  // Re-export: export { X } from './y' → export_statement > export_clause > export_specifier
  const exportClause = findChild(importNode, "export_clause");
  if (exportClause) {
    const bindings: Binding[] = [];
    for (const specifier of exportClause.namedChildren) {
      if (specifier.type !== "export_specifier") continue;

      const identifiers: string[] = [];
      for (const child of specifier.namedChildren) {
        if (child.type === "identifier") identifiers.push(child.text);
      }

      if (identifiers.length === 1) {
        // export { User } from './base' → re-exports User as User
        bindings.push({ local: identifiers[0], exported: identifiers[0] });
      } else if (identifiers.length === 2) {
        // export { Repo as Repository } → first id = source name, second = exported
        bindings.push({ local: identifiers[1], exported: identifiers[0] });
      }
    }
    return bindings.length > 0 ? bindings : undefined;
  }

  return undefined;
}

export function extractPythonNamedBindings(importNode: Parser.SyntaxNode): Binding[] | undefined {
  // Only from import_from_statement, not plain import_statement.
  if (importNode.type !== "import_from_statement") return undefined;

  const bindings: Binding[] = [];
  const moduleNameNode = importNode.childForFieldName("module_name");
  for (const child of importNode.namedChildren) {
    if (child.type === "dotted_name") {
      // Skip the module_name (the source module's first dotted_name).
      if (moduleNameNode && child.startIndex === moduleNameNode.startIndex) continue;

      // An imported name: from x import User
      const name = child.text;
      if (name) bindings.push({ local: name, exported: name });
    }

    if (child.type === "aliased_import") {
      // from x import Repo as R
      const dottedName = findChild(child, "dotted_name");
      const aliasIdent = findChild(child, "identifier");
      if (dottedName && aliasIdent) {
        bindings.push({ local: aliasIdent.text, exported: dottedName.text });
      }
    }
  }

  return bindings.length > 0 ? bindings : undefined;
}

export function extractJavaNamedBindings(importNode: Parser.SyntaxNode): Binding[] | undefined {
  // import_declaration > scoped_identifier "com.example.models.User"
  if (importNode.type !== "import_declaration") return undefined;

  // Wildcard imports (.*) don't produce named bindings — scan ALL children.
  for (const child of importNode.children) {
    if (child.type === "asterisk") return undefined;
  }

  const scopedId = findChild(importNode, "scoped_identifier");
  if (!scopedId) return undefined;

  const fullText = scopedId.text;
  const lastDot = fullText.lastIndexOf(".");
  if (lastDot === -1) return undefined;

  const className = fullText.slice(lastDot + 1);
  // Lowercase last segment = package import, not a class import — skip.
  if (className[0] && className[0] === className[0].toLowerCase()) return undefined;

  return [{ local: className, exported: className }];
}
