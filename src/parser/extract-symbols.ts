import * as crypto from "crypto";
import Parser from "tree-sitter";
import type { Language, Symbol, SymbolKind, Visibility, Modifier } from "../types/index.js";
import type { ASTNode } from "./ast-node.js";
import { LANGUAGE_QUERIES } from "./queries.js";

/** Raw relationship hint extracted from AST — resolved into Relationship in Phase 3 */
export interface RawRelationshipHint {
  readonly kind: "import" | "call" | "inherits" | "implements";
  readonly sourceFile: string;
  /** For imports: the module specifier. For calls/heritage: the target name. */
  readonly targetName: string;
  /** For heritage: the name of the child class (used to look up its symbol ID). */
  readonly childSymbolId?: string;
  readonly startLine: number;
}

/** Combined result of query-based extraction */
export interface ExtractionResult {
  readonly symbols: Symbol[];
  readonly hints: RawRelationshipHint[];
}

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
 * Fallback path — used when query compilation fails.
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
 * Extract symbols AND raw relationship hints using tree-sitter queries.
 * Processes @definition.*, @import, @call, and @heritage captures in one pass.
 * Requirements: 3.2, 4.1, 4.2, 5.1, 5.2, 5.3, 5.4
 */
export function extractSymbolsWithQueries(
  ast: ASTNode,
  filePath: string,
  language: Language,
  parser: Parser,
): ExtractionResult {
  const queryString = LANGUAGE_QUERIES[language];
  const lang = parser.getLanguage();

  let query: Parser.Query;
  try {
    query = new Parser.Query(lang, queryString);
  } catch (err) {
    console.warn(`[parser] Warning: failed to compile query for ${language}: ${String(err)}`);
    return { symbols: extractSymbols(ast, filePath), hints: [] };
  }

  const tree = parser.parse(ast.text);
  const matches = query.matches(tree.rootNode);

  const symbols: Symbol[] = [];
  const hints: RawRelationshipHint[] = [];

  for (const match of matches) {
    const nameCapture = match.captures.find((c) => c.name === "name");
    const defCapture = match.captures.find((c) => c.name.startsWith("definition."));
    const importSourceCapture = match.captures.find((c) => c.name === "import.source");
    const callNameCapture = match.captures.find((c) => c.name === "call.name");
    const heritageExtendsCapture = match.captures.find((c) => c.name === "heritage.extends");
    // heritage.implements (Java/C#/PHP) and heritage.trait (Rust) both produce "implements" hints
    const heritageImplCapture = match.captures.find(
      (c) => c.name === "heritage.implements" || c.name === "heritage.trait",
    );
    const heritageClassCapture = match.captures.find((c) => c.name === "heritage.class");

    // ── Definition symbols ──────────────────────────────────────────────────
    if (nameCapture && defCapture) {
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

    // ── Import hints ────────────────────────────────────────────────────────
    if (importSourceCapture) {
      const raw = importSourceCapture.node.text.replace(/['"]/g, "").trim();
      if (raw) {
        hints.push({
          kind: "import",
          sourceFile: filePath,
          targetName: raw,
          startLine: importSourceCapture.node.startPosition.row,
        });
      }
    }

    // ── Call hints ──────────────────────────────────────────────────────────
    if (callNameCapture) {
      const calleeName = callNameCapture.node.text.trim();
      if (calleeName) {
        hints.push({
          kind: "call",
          sourceFile: filePath,
          targetName: calleeName,
          startLine: callNameCapture.node.startPosition.row,
        });
      }
    }

    // ── Heritage hints ──────────────────────────────────────────────────────
    if (heritageExtendsCapture && heritageClassCapture) {
      hints.push({
        kind: "inherits",
        sourceFile: filePath,
        targetName: heritageExtendsCapture.node.text.trim(),
        childSymbolId: heritageClassCapture.node.text.trim(),
        startLine: heritageExtendsCapture.node.startPosition.row,
      });
    }

    if (heritageImplCapture && heritageClassCapture) {
      hints.push({
        kind: "implements",
        sourceFile: filePath,
        targetName: heritageImplCapture.node.text.trim(),
        childSymbolId: heritageClassCapture.node.text.trim(),
        startLine: heritageImplCapture.node.startPosition.row,
      });
    }
  }

  return { symbols, hints };
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
