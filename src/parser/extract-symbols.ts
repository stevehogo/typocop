import * as crypto from "crypto";
import Parser from "tree-sitter";
import type { Language, Symbol, SymbolKind, Visibility, Modifier } from "../types/index.js";
import type { ASTNode } from "./ast-node.js";
import { LANGUAGE_QUERIES } from "./queries.js";

/** Map tree-sitter @definition.* capture suffix to SymbolKind */
const DEFINITION_KIND_MAP: Readonly<Record<string, SymbolKind>> = {
  "definition.class": "class",
  "definition.interface": "interface",
  "definition.function": "function",
  "definition.method": "method",
  "definition.struct": "class",
  "definition.enum": "type",
  "definition.trait": "interface",
  "definition.impl": "class",
  "definition.module": "class",
  "definition.namespace": "class",
  "definition.type": "type",
  "definition.property": "variable",
  "definition.constructor": "method",
  "definition.record": "class",
  "definition.delegate": "type",
  "definition.annotation": "type",
  "definition.macro": "function",
  "definition.typedef": "type",
  "definition.union": "type",
  "definition.template": "class",
  "definition.const": "variable",
  "definition.static": "variable",
};

const SYMBOL_NODE_TYPES: ReadonlySet<string> = new Set([
  "function_declaration", "method_declaration", "class_declaration",
  "interface_declaration", "variable_declaration", "method_definition",
  "function_definition", "class_definition", "function_item",
]);

function nodeTypeToKind(nodeType: string): SymbolKind {
  if (nodeType.includes("function")) return "function";
  if (nodeType.includes("method")) return "method";
  if (nodeType.includes("class")) return "class";
  if (nodeType.includes("interface")) return "interface";
  return "variable";
}

/**
 * Extract symbols from an ASTNode tree using structural heuristics.
 * Uses crypto.randomUUID() for unique IDs.
 *
 * This is the primary public API — works with both real and synthetic ASTNodes.
 * Requirements: 2.13, 2.14
 */
export function extractSymbols(ast: ASTNode, filePath: string): Symbol[] {
  const symbols: Symbol[] = [];
  visitNode(ast, filePath, symbols);
  return symbols;
}

function visitNode(node: ASTNode, filePath: string, out: Symbol[]): void {
  if (SYMBOL_NODE_TYPES.has(node.type)) {
    const sym = buildSymbol(node, filePath);
    if (sym) out.push(sym);
  }
  for (const child of node.children) {
    visitNode(child, filePath, out);
  }
}

function buildSymbol(node: ASTNode, filePath: string): Symbol | null {
  const nameNode = node.children.find(
    (c) => c.type === "identifier" || c.type === "type_identifier" ||
            c.type === "property_identifier" || c.type === "name",
  );
  const name = nameNode?.text?.trim() ?? "";
  if (!name) return null;

  return {
    id: crypto.randomUUID(),
    name,
    kind: nodeTypeToKind(node.type),
    location: {
      filePath,
      startLine: node.startPosition.row,
      startColumn: node.startPosition.column,
      endLine: node.endPosition.row,
      endColumn: node.endPosition.column,
    },
    visibility: "public",
    modifiers: [],
  };
}

/**
 * Extract symbols using tree-sitter queries for accurate, language-aware extraction.
 * Requires a live Parser instance with the correct language set.
 * Used by the indexing pipeline for production extraction.
 */
export function extractSymbolsWithQueries(
  ast: ASTNode,
  filePath: string,
  language: Language,
  parser: Parser,
): Symbol[] {
  const queryString = LANGUAGE_QUERIES[language];
  const lang = parser.getLanguage();

  let query: Parser.Query;
  try {
    query = lang.query(queryString);
  } catch (err) {
    console.warn(`[parser] Warning: failed to compile query for ${language}: ${String(err)}`);
    return extractSymbols(ast, filePath);
  }

  const tree = parser.parse(ast.text);
  const matches = query.matches(tree.rootNode);
  const symbols: Symbol[] = [];

  for (const match of matches) {
    const nameCapture = match.captures.find((c) => c.name === "name");
    const defCapture = match.captures.find((c) => c.name.startsWith("definition."));

    if (!nameCapture || !defCapture) continue;

    const name = nameCapture.node.text.trim();
    if (!name) continue;

    const kind: SymbolKind = DEFINITION_KIND_MAP[defCapture.name] ?? "variable";
    const defNode = defCapture.node;

    symbols.push({
      id: `${filePath}:${name}:${defNode.startPosition.row}`,
      name,
      kind,
      location: {
        filePath,
        startLine: defNode.startPosition.row,
        startColumn: defNode.startPosition.column,
        endLine: defNode.endPosition.row,
        endColumn: defNode.endPosition.column,
      },
      visibility: inferVisibility(defNode, language),
      modifiers: inferModifiers(defNode, language),
    });
  }

  return symbols;
}

function inferVisibility(node: Parser.SyntaxNode, language: Language): Visibility {
  const parentText = node.parent?.text ?? "";

  if (language === "typescript" || language === "javascript") {
    if (parentText.includes("private ")) return "private";
    if (parentText.includes("protected ")) return "protected";
    return "public";
  }

  if (language === "java" || language === "csharp") {
    if (parentText.includes("private ")) return "private";
    if (parentText.includes("protected ")) return "protected";
    if (parentText.includes("internal ")) return "internal";
    return "public";
  }

  if (language === "rust") {
    if (node.text.startsWith("pub ") || parentText.startsWith("pub ")) return "public";
    return "private";
  }

  return "public";
}

function inferModifiers(node: Parser.SyntaxNode, language: Language): Modifier[] {
  const text = node.text;
  const modifiers: Modifier[] = [];

  if (
    language === "typescript" || language === "javascript" ||
    language === "java" || language === "csharp"
  ) {
    if (text.includes("static ")) modifiers.push("static");
    if (text.includes("abstract ")) modifiers.push("abstract");
    if (text.includes("async ")) modifiers.push("async");
    if (text.includes("readonly ")) modifiers.push("readonly");
    if (text.includes("const ")) modifiers.push("const");
  }

  return modifiers;
}
