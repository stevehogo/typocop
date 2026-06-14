import * as crypto from "crypto";
import Parser from "tree-sitter";
import type { Language, Symbol, SymbolKind, Visibility, Modifier } from "../../core/domain.js";
import { type ASTNode, fromSyntaxNode } from "./ast-node.js";
import { LANGUAGE_QUERIES } from "./queries.js";
import { generateSymbolId } from "./symbol-id.js";

/** Raw relationship hint extracted from AST — resolved into Relationship in Phase 3 */
export interface RawRelationshipHint {
  readonly kind: "import" | "call" | "inherits" | "implements";
  readonly sourceFile: string;
  /** For imports: the module specifier. For calls/heritage: the target name. */
  readonly targetName: string;
  /** For heritage: the name of the child class (used to look up its symbol ID). */
  readonly childSymbolId?: string;
  readonly startLine: number;
  readonly language: Language;
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
 * Compiled tree-sitter queries cached by the `Parser.Language` they were
 * compiled against (B2).
 *
 * `LANGUAGE_QUERIES` is fixed per language, so the S-expression compilation can
 * be done once and reused for every subsequent file. The cache key is the actual
 * grammar object (`parser.getLanguage()`), NOT the file extension: a `Query` is
 * compiled against a specific grammar and must only run against trees produced by
 * that same grammar. Keying on the grammar object guarantees the cached query
 * always matches the tree it queries — even while the parser's grammar is
 * selected statefully (the tsx vs ts grammars are distinct `Language` objects, so
 * they get distinct cache entries automatically). `getLanguage()` returns a stable
 * reference equal to the grammar export, so same-language files share one entry.
 *
 * A `null` value records that compilation failed for that grammar, so we don't
 * retry compilation (and re-log the warning) on every file.
 *
 * Concurrency note (B5): this module-level cache is shared across the parse
 * worker pool, but it is race-free because the whole extraction path
 * (`extractSymbolsWithQueries` → `getCompiledQuery` → `query.matches`) is fully
 * synchronous — there is no `await` between the cache `has` check and `set`, so
 * concurrent workers cannot interleave on the event loop. If extraction ever
 * gains an `await`, two workers could double-compile a query (harmless duplicate
 * work, absorbed by identical query output + `deduplicateById`).
 */
const queryCache = new Map<Parser.Language, Parser.Query | null>();

/** Test-only counter: number of `new Parser.Query(...)` compilations performed. */
let queryCompileCount = 0;

/** Test hook — number of query compilations since the last reset. */
export function getQueryCompileCount(): number {
  return queryCompileCount;
}

/** Test hook — clear the query cache and reset the compile counter. */
export function resetQueryCache(): void {
  queryCache.clear();
  queryCompileCount = 0;
}

/**
 * Compile (or fetch a cached) tree-sitter query for the given variant.
 * Returns `null` if compilation has failed for this variant.
 */
function getCompiledQuery(
  lang: Parser.Language,
  queryString: string,
  language: Language,
): Parser.Query | null {
  if (queryCache.has(lang)) {
    return queryCache.get(lang) ?? null;
  }

  try {
    const query = new Parser.Query(lang, queryString);
    queryCompileCount++;
    queryCache.set(lang, query);
    return query;
  } catch (err) {
    console.warn(`[parser] Warning: failed to compile query for ${language}: ${String(err)}`);
    queryCache.set(lang, null);
    return null;
  }
}

/**
 * Extract symbols AND raw relationship hints using tree-sitter queries.
 * Processes @definition.*, @import, @call, and @heritage captures in one pass.
 *
 * Queries the live `Parser.Tree` produced by a single upstream parse (B1) — it
 * does NOT reparse. The eager `ASTNode` tree is only materialized on the
 * fallback path (query compilation failure), never on the common path.
 *
 * Requirements: 3.2, 4.1, 4.2, 5.1, 5.2, 5.3, 5.4
 */
export function extractSymbolsWithQueries(
  tree: Parser.Tree,
  filePath: string,
  language: Language,
  parser: Parser,
): ExtractionResult {
  const queryString = LANGUAGE_QUERIES[language];
  const lang = parser.getLanguage();

  const query = getCompiledQuery(lang, queryString, language);
  if (query === null) {
    // Fallback: build the eager ASTNode lazily, only on this rare path.
    return { symbols: extractSymbols(fromSyntaxNode(tree.rootNode), filePath), hints: [] };
  }

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

      // Anchor the ID to the NAME node, not the definition node. Overlapping
      // query patterns (e.g. the bare `lexical_declaration` and the
      // `export_statement`-wrapped variant) match the same symbol twice with
      // different definition-node start columns but the SAME name node. Keying
      // on the name position collapses those duplicate emissions via
      // `deduplicateById`, while still giving genuinely distinct same-line
      // symbols distinct IDs (their name nodes sit at different columns).
      const nameNode = nameCapture.node;

      symbols.push({
        id: generateSymbolId(
          filePath,
          name,
          nameNode.startPosition.row,
          nameNode.startPosition.column,
        ),
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
          language,
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
          language,
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
        language,
      });
    }

    if (heritageImplCapture && heritageClassCapture) {
      hints.push({
        kind: "implements",
        sourceFile: filePath,
        targetName: heritageImplCapture.node.text.trim(),
        childSymbolId: heritageClassCapture.node.text.trim(),
        startLine: heritageImplCapture.node.startPosition.row,
        language,
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
