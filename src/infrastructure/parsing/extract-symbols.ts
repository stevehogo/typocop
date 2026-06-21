import * as crypto from "crypto";
import Parser from "tree-sitter";
import type { Language, Symbol, SymbolKind, Visibility, Modifier } from "../../core/domain.js";
import { type ASTNode, fromSyntaxNode } from "./ast-node.js";
import { LANGUAGE_QUERIES } from "./queries.js";
import { generateSymbolId } from "./symbol-id.js";
import { generateLogicalKey, OrdinalAllocator } from "./logical-key.js";
import { computeComplexity } from "./complexity.js";
import { extractNamedBindings } from "./named-bindings.js";
import { countCallArguments, inferCallForm, type CallForm } from "./call-extractors.js";
import { extractMethodSignature } from "./signature.js";
import { isNodeExported } from "./export-detection.js";
import { isTypeEnvEnabled } from "../../platform/utils/limits.js";
import { buildTypeEnv, type TypeEnvironment } from "./type-env/type-env.js";
import { typeConfigs } from "./type-env/extractors/index.js";

/**
 * `@definition.*` capture suffixes that denote a callable (function / method /
 * constructor) — the only kinds for which complexity is computed (E2).
 */
const CALLABLE_DEFINITION_CAPTURES: ReadonlySet<string> = new Set([
  "definition.function",
  "definition.method",
  "definition.constructor",
  "definition.macro",
]);

/** Raw relationship hint extracted from AST — resolved into Relationship in Phase 3 */
export interface RawRelationshipHint {
  readonly kind: "import" | "call" | "inherits" | "implements" | "access";
  readonly sourceFile: string;
  /**
   * For imports: the module specifier. For calls/heritage: the target name.
   * For `access` (E3 `member.access`): the property key being read (`data` in
   * `result.data`).
   */
  readonly targetName: string;
  /** For heritage: the name of the child class (used to look up its symbol ID). */
  readonly childSymbolId?: string;
  readonly startLine: number;
  readonly language: Language;
  // ── E1 deeper-resolution hint fields (OPTIONAL; additive) ─────────────────
  /**
   * For a member call `recv.method(...)`: the raw receiver expression text
   * (e.g. `this`, `user`, `this.repo`). Enables MRO-aware member-call
   * resolution — walking the receiver type's linearised ancestor chain instead
   * of the global name fallback. Absent for bare `fn(...)` calls.
   */
  readonly receiverText?: string;
  /**
   * For a call: the `id` of the nearest enclosing definition symbol (function/
   * method/class) at the call site. Lets resolution attribute the call to its
   * true caller and lets chain-binding thread `returnType` through `a.b().c()`.
   */
  readonly enclosingSymbolId?: string;
  /**
   * Wave 3 (Tier B): for a member call `recv.method(...)` whose `recv` is a BARE
   * local identifier (not `this`/`self`/a chain — those are handled by
   * `resolveReceiverType`), the receiver variable's resolved type NAME from the
   * per-file AST type-env (`typeEnv.lookup`). Phase 3 resolves it via
   * `typeNameToSymbol` and searches `methodsByOwner`+`mroLinear` BEFORE the
   * receiver-text path. Only populated when the Tier-B flag (`TYPOCOP_TYPE_ENV`)
   * is on AND the language has a registered type-extractor config. Transient —
   * NEVER persisted on a Symbol/Relationship.
   * MUST stay structurally mirrored in `CachedRelationshipHint`
   * (`core/ports/index-cache.ts`) or it is dropped on the incremental path.
   */
  readonly receiverType?: string;
  // ── Wave 4 call-resolution precision carriers (OPTIONAL; additive; `call`) ──
  /**
   * Wave 4: the number of DIRECT arguments at the call site, computed by
   * {@link countCallArguments}. `undefined` (NEVER `0`) when the argument
   * container can't be located cheaply — that `undefined` is the signal Phase 3's
   * arity filter uses to SKIP arity narrowing for this call entirely. Lets the
   * resolver disambiguate same-name overloads by `parameterCount === argCount`.
   * Absent for non-call hints.
   * MUST stay structurally mirrored in `CachedRelationshipHint`
   * (`core/ports/index-cache.ts`) or it is dropped on the incremental path.
   */
  readonly argCount?: number;
  /**
   * Wave 4: the call-site form (`free` / `member` / `constructor`), computed by
   * {@link inferCallForm}. Lets Phase 3's callable-kind filter target the right
   * kinds (constructor-form calls resolve to the `class`, others to
   * `function`/`method`). `undefined` when the form can't be determined. Absent
   * for non-call hints.
   * MUST stay structurally mirrored in `CachedRelationshipHint`
   * (`core/ports/index-cache.ts`) or it is dropped on the incremental path.
   */
  readonly callForm?: CallForm;
  // ── Wave 1 named-binding carrier (OPTIONAL; additive; `import` hints only) ──
  /**
   * For a named import (`import { User as U } from './models'`): the
   * `{ local, exported }` pairs extracted from the import AST node. `local` is
   * the name visible in the importing file; `exported` is the original name in
   * the source file. Lets Phase 3 populate `namedImportMap` so `walkBindingChain`
   * (Tier 2a-named) fires for aliases + re-export chains. Absent for default /
   * namespace / wildcard / side-effect imports (and for non-import hints).
   * MUST stay structurally mirrored in `CachedRelationshipHint`
   * (`core/ports/index-cache.ts`) or it is dropped on the incremental path.
   */
  readonly namedBindings?: { local: string; exported: string }[];
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
  // Assign per-file logicalKey ordinals in original (DFS, pre-order) traversal
  // order — the same order symbols are emitted — so the mapping is deterministic.
  const ordinals = new OrdinalAllocator();
  visitNode(ast, filePath, symbols, ordinals);
  return symbols;
}

function visitNode(node: ASTNode, filePath: string, out: Symbol[], ordinals: OrdinalAllocator): void {
  if (SYMBOL_NODE_TYPES.has(node.type)) {
    const sym = buildSymbol(node, filePath, ordinals);
    if (sym) out.push(sym);
  }
  for (const child of node.children) {
    visitNode(child, filePath, out, ordinals);
  }
}

function buildSymbol(node: ASTNode, filePath: string, ordinals: OrdinalAllocator): Symbol | null {
  const nameNode = node.children.find(
    (c) => c.type === "identifier" || c.type === "type_identifier" ||
            c.type === "property_identifier" || c.type === "name",
  );
  const name = nameNode?.text?.trim() ?? "";
  if (!name) return null;

  const kind = nodeTypeToKind(node.type);
  return {
    id: crypto.randomUUID(),
    logicalKey: generateLogicalKey(filePath, name, kind, ordinals.next(name, kind)),
    name,
    kind,
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

  // ── Wave 3 (Tier B): per-file AST type-env ──────────────────────────────────
  // Built ONCE per file, lazily, ONLY when the Tier-B flag is on AND the language
  // has a registered type-extractor config. Reuses the already-parsed tree (NO
  // re-parse). Phase 2 has no global symbol index, so it passes localClassNames
  // only (no cross-file source) — the common `new User()` case resolves locally;
  // cross-file ctor verification is deferred to Phase 3. When the flag is off the
  // env is never built and `receiverType` is never populated → byte-identical.
  const typeEnvEnabled = isTypeEnvEnabled() && typeConfigs[language] !== undefined;
  let typeEnv: TypeEnvironment | undefined;
  const getTypeEnv = (): TypeEnvironment => {
    if (typeEnv === undefined) typeEnv = buildTypeEnv(tree, language);
    return typeEnv;
  };

  for (const match of matches) {
    const nameCapture = match.captures.find((c) => c.name === "name");
    const defCapture = match.captures.find((c) => c.name.startsWith("definition."));
    const importSourceCapture = match.captures.find((c) => c.name === "import.source");
    // Full import statement node (`@import`) — used for named-binding extraction
    // (Wave 1). Present alongside `@import.source` in every language's import
    // pattern, so no query change is needed.
    const importStmtCapture = match.captures.find((c) => c.name === "import");
    const callNameCapture = match.captures.find((c) => c.name === "call.name");
    // Wave 4: the enclosing `@call` node (paired with every `@call.name` capture
    // in the queries) — the call-form / argument-count classifiers run on it.
    const callCapture = match.captures.find((c) => c.name === "call");
    const memberAccessCapture = match.captures.find((c) => c.name === "member.access");
    const memberObjectCapture = match.captures.find((c) => c.name === "member.object");
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

      // E1: optional callable metadata. Only attach fields that resolve to a
      // concrete value so non-callable symbols (and symbols where the grammar
      // exposes nothing useful) carry no empty keys — keeping the Symbol shape
      // identical to pre-E1 wherever no info exists (golden output unchanged).
      // Wave 2 (1.2): one variadic-aware signature pass replaces the old
      // extractParameterCount/extractReturnType pair — variadic arities yield
      // `parameterCount: undefined`, which the conditional spread below drops.
      const { parameterCount, returnType } = extractMethodSignature(defNode);
      const ownerId = extractOwnerId(defNode, filePath);

      // Wave 2 (1.3): per-language export detection — ORTHOGONAL to
      // `visibility` below. `isNodeExported` always returns a concrete boolean
      // for a known language, so the field is always attached for definition
      // symbols (the PARSE_VERSION bump re-emits warm-cache files).
      const isExported = isNodeExported(defNode, name, language);

      // E2: complexity is only meaningful for callables (function/method/
      // constructor). Computed as a pure subtree walk over the live tree-sitter
      // node — absent for everything else, so the Symbol shape stays pre-E2
      // identical where it doesn't apply.
      const complexity = CALLABLE_DEFINITION_CAPTURES.has(defCapture.name)
        ? computeComplexity(defNode, language)
        : undefined;

      symbols.push({
        id: generateSymbolId(
          filePath,
          name,
          nameNode.startPosition.row,
          nameNode.startPosition.column,
        ),
        // logicalKey is assigned in a single ordered pass AFTER intra-file
        // dedup-by-id (below), so overlapping query patterns that collapse to the
        // same `id` do not consume an ordinal twice.
        logicalKey: "",
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
        ...(parameterCount !== undefined ? { parameterCount } : {}),
        ...(returnType !== undefined ? { returnType } : {}),
        ...(ownerId !== undefined ? { ownerId } : {}),
        ...(complexity !== undefined ? { complexity } : {}),
        isExported,
      });
    }

    // ── Import hints ────────────────────────────────────────────────────────
    if (importSourceCapture) {
      const raw = importSourceCapture.node.text.replace(/['"]/g, "").trim();
      if (raw) {
        // Wave 1: extract named bindings (`import { User as U }`) from the full
        // import node so Phase 3 can populate `namedImportMap` (Tier 2a-named).
        // Only attach when non-empty so default/namespace/wildcard imports keep
        // the pre-wave hint shape (golden output unchanged).
        const namedBindings = importStmtCapture
          ? extractNamedBindings(importStmtCapture.node, language)
          : undefined;
        hints.push({
          kind: "import",
          sourceFile: filePath,
          targetName: raw,
          startLine: importSourceCapture.node.startPosition.row,
          language,
          ...(namedBindings !== undefined ? { namedBindings } : {}),
        });
      }
    }

    // ── Call hints ──────────────────────────────────────────────────────────
    if (callNameCapture) {
      const calleeName = callNameCapture.node.text.trim();
      if (calleeName) {
        // E1: receiver text (for `recv.method(...)`) and the nearest enclosing
        // definition id, so resolution can do MRO-aware member-call resolution
        // and chain binding. Both optional — bare `fn()` carries no receiver.
        const receiverText = extractReceiverText(callNameCapture.node);
        const enclosingSymbolId = extractEnclosingSymbolId(callNameCapture.node, filePath);
        // Wave 3 (Tier B): for a BARE local receiver (not this/self/chained —
        // those are handled by resolveReceiverType), resolve its type via the
        // per-file type-env so Phase 3 can target the right owning method.
        const receiverType =
          typeEnvEnabled && receiverText !== undefined && isBareReceiver(receiverText)
            ? getTypeEnv().lookup(receiverText, callNameCapture.node)
            : undefined;
        // Wave 4: the call node is the `@call` capture (paired with `@call.name`
        // in every query); fall back to the name node's parent chain on the rare
        // path where only `@call.name` is present. `argCount` stays `undefined`
        // (not `0`) when the argument container can't be located — the resolver's
        // arity filter relies on that to skip narrowing. `callForm` discriminates
        // free/member/constructor for the callable-kind filter.
        const callNode = callCapture?.node ?? findEnclosingCallNode(callNameCapture.node);
        const argCount = countCallArguments(callNode);
        const callForm = callNode ? inferCallForm(callNode, callNameCapture.node) : undefined;
        hints.push({
          kind: "call",
          sourceFile: filePath,
          targetName: calleeName,
          startLine: callNameCapture.node.startPosition.row,
          language,
          ...(receiverText !== undefined ? { receiverText } : {}),
          ...(enclosingSymbolId !== undefined ? { enclosingSymbolId } : {}),
          ...(receiverType !== undefined ? { receiverType } : {}),
          ...(argCount !== undefined ? { argCount } : {}),
          ...(callForm !== undefined ? { callForm } : {}),
        });
      }
    }

    // ── Member-access hints (E3; shared member.access capture) ───────────────
    // A `recv.prop` property READ. Skipped when the member expression is itself
    // a call callee (`recv.method(...)`) — those are already emitted as `call`
    // hints, so this never duplicates the E1 receiver capture. Carries the
    // property as `targetName` and the receiver as `receiverText`, plus the
    // nearest enclosing definition id so a consumer's reads can be attributed.
    if (memberAccessCapture && memberObjectCapture) {
      const member = memberAccessCapture.node.parent; // member_expression
      const isCallee =
        member?.parent?.type === "call_expression" &&
        member.parent.childForFieldName("function") === member;
      if (!isCallee) {
        const key = memberAccessCapture.node.text.trim();
        const receiver = memberObjectCapture.node.text.trim();
        if (key && receiver) {
          const enclosingSymbolId = extractEnclosingSymbolId(memberAccessCapture.node, filePath);
          hints.push({
            kind: "access",
            sourceFile: filePath,
            targetName: key,
            startLine: memberAccessCapture.node.startPosition.row,
            language,
            receiverText: receiver,
            ...(enclosingSymbolId !== undefined ? { enclosingSymbolId } : {}),
          });
        }
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

  return { symbols: assignLogicalKeys(symbols), hints };
}

/**
 * Dedup symbols by their intra-run `id` (collapsing overlapping query matches
 * that share a name node), then assign each survivor its stable `logicalKey`
 * with a per-file ordinal allocated in original emission order (A1). Doing this
 * AFTER dedup guarantees an ordinal is consumed exactly once per distinct symbol,
 * so the key is deterministic and overlap-robust. Distinct `(name, kind)` symbols
 * get ordinal 0; only genuine collisions (e.g. two same-named arrow fns) advance.
 */
function assignLogicalKeys(symbols: Symbol[]): Symbol[] {
  const ordinals = new OrdinalAllocator();
  const seen = new Set<string>();
  const out: Symbol[] = [];
  for (const sym of symbols) {
    if (seen.has(sym.id)) continue;
    seen.add(sym.id);
    out.push({
      ...sym,
      logicalKey: generateLogicalKey(
        sym.location.filePath,
        sym.name,
        sym.kind,
        ordinals.next(sym.name, sym.kind),
      ),
    });
  }
  return out;
}

// ─── E1 callable / call metadata extraction (language-agnostic, best-effort) ──
//
// Parameter-count + return-type extraction moved to `signature.ts` in Wave 2
// (1.2) — `extractMethodSignature` adds variadic detection + broad return-type
// coverage. `ownerId`/receiver/enclosing helpers remain here.

/** Definition node types that own methods/constructors (E1 `ownerId`). */
const OWNER_NODE_TYPES: ReadonlySet<string> = new Set([
  "class_declaration", "class_definition", "class_specifier", "class",
  "interface_declaration", "struct_declaration", "struct_specifier",
  "struct_item", "trait_item", "impl_item", "enum_declaration",
  "record_declaration", "object_declaration", "protocol_declaration",
  "namespace_definition",
]);

/** Identifier child types that name a definition node. */
const NAME_CHILD_TYPES: ReadonlySet<string> = new Set([
  "identifier", "type_identifier", "property_identifier", "name",
  "namespace_identifier", "simple_identifier", "constant",
]);

function nameNodeOf(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  const byField = node.childForFieldName("name");
  if (byField) return byField;
  return node.namedChildren.find((c) => NAME_CHILD_TYPES.has(c.type));
}

/**
 * Compute the intra-run `id` of the nearest enclosing class/struct/interface for
 * a method/constructor definition node (E1 `ownerId`). Mirrors the symbol-id
 * derivation used for definitions (anchored to the owner's NAME node) so the
 * value matches the owner Symbol's real `id`. Returns `undefined` at top level.
 */
function extractOwnerId(defNode: Parser.SyntaxNode, filePath: string): string | undefined {
  let cur = defNode.parent;
  while (cur) {
    if (OWNER_NODE_TYPES.has(cur.type)) {
      const nameNode = nameNodeOf(cur);
      if (nameNode) {
        return generateSymbolId(
          filePath,
          nameNode.text.trim(),
          nameNode.startPosition.row,
          nameNode.startPosition.column,
        );
      }
    }
    cur = cur.parent;
  }
  return undefined;
}

/**
 * For a call-name node nested in a member/attribute/selector expression, return
 * the raw receiver text (`recv` in `recv.method(...)`). Returns `undefined` for
 * a bare-identifier call. Best-effort across grammars — looks one level up at the
 * member-access node and takes its object/leading child.
 */
/**
 * Wave 4 fallback: locate the enclosing call node for a `@call.name` node when no
 * sibling `@call` capture is present (rare — the queries pair them). Walks up at
 * most a few levels to the nearest call-expression-like node and returns it (or
 * `undefined`). `countCallArguments` / `inferCallForm` then run on it.
 */
function findEnclosingCallNode(callNameNode: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  const CALL_NODE_TYPES = new Set([
    "call_expression", "call", "method_invocation", "function_call_expression",
    "member_call_expression", "nullsafe_member_call_expression", "scoped_call_expression",
    "object_creation_expression", "new_expression", "constructor_invocation",
    "implicit_object_creation_expression", "composite_literal", "struct_expression",
    "qualified_identifier",
  ]);
  let cur: Parser.SyntaxNode | null = callNameNode.parent;
  // Bounded walk: call name → (member/access wrapper) → call node.
  for (let depth = 0; cur && depth < 3; depth++) {
    if (CALL_NODE_TYPES.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return undefined;
}

function extractReceiverText(callNameNode: Parser.SyntaxNode): string | undefined {
  const access = callNameNode.parent;
  if (!access) return undefined;
  const memberTypes = new Set([
    "member_expression", "attribute", "selector_expression", "field_expression",
    "member_access_expression", "scoped_identifier", "navigation_expression",
    "member_call_expression", "scoped_call_expression",
  ]);
  if (!memberTypes.has(access.type)) return undefined;
  // Prefer the explicit object/receiver field where the grammar provides one.
  const object =
    access.childForFieldName("object") ??
    access.childForFieldName("receiver") ??
    access.childForFieldName("path") ??
    access.namedChildren.find((c) => c !== callNameNode);
  const text = object?.text.trim();
  return text && text.length > 0 ? text : undefined;
}

/**
 * Walk up from a call site to the nearest enclosing definition node and return
 * its intra-run `id` (E1 `enclosingSymbolId`). Returns `undefined` for calls at
 * module top level (no enclosing definition).
 */
function extractEnclosingSymbolId(callNameNode: Parser.SyntaxNode, filePath: string): string | undefined {
  const DEF_TYPES = new Set([
    "function_declaration", "function_definition", "function_item",
    "method_definition", "method_declaration", "constructor_declaration",
    "arrow_function", "function_expression", "local_function_statement",
  ]);
  let cur = callNameNode.parent;
  while (cur) {
    if (DEF_TYPES.has(cur.type)) {
      const nameNode = nameNodeOf(cur);
      if (nameNode) {
        return generateSymbolId(
          filePath,
          nameNode.text.trim(),
          nameNode.startPosition.row,
          nameNode.startPosition.column,
        );
      }
    }
    cur = cur.parent;
  }
  return undefined;
}

/**
 * Whether a receiver expression is a BARE local-variable identifier — the only
 * form the Wave-3 type-env fallback handles in Phase 2. Excludes `this`/`self`/
 * `$this` and chained/`this.field` forms (those are covered by
 * `resolveReceiverType` in Phase 3 — avoid double-handling, per the precision
 * guardrail). Allows a leading `$` for PHP variables (`$repo`).
 */
function isBareReceiver(receiverText: string): boolean {
  const text = receiverText.trim();
  if (text === "this" || text === "self" || text === "$this") return false;
  return /^\$?[A-Za-z_][\w$]*$/.test(text);
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
