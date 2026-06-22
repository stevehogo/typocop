/**
 * Method/function signature extraction (Wave 2, 1.2).
 *
 * A single pass over a callable definition node → `{ parameterCount, returnType }`.
 * Replaces the thin `extractParameterCount` / `extractReturnType` pair with:
 *   - VARIADIC detection — `*args`/`**kwargs` (Python), `...rest` (TS/JS),
 *     `a ...int` (Go), `Object...` (Java), `vararg` (Kotlin), bare `...` (C/C++)
 *     all yield `parameterCount: undefined` (the count is not meaningful for a
 *     variadic arity, and a definite count would over-count for resolution).
 *   - BROAD return-type extraction — Go multi-return first type, C# `returns`
 *     field, C/C++ `type` field (`void` → undefined), Rust `return_type` value
 *     node, plus the generic `type_annotation`/`return_type` child fallback
 *     (TS/Python).
 *
 * Ported from the legacy parser's `utils/signature-extractors.ts`. The original
 * was `any`-typed; typocop uses `Parser.SyntaxNode`, whose tree-sitter API
 * (`childForFieldName`, `namedChildren`, `children`, `previousSibling`,
 * `firstNamedChild`, `isNamed`) matches, so this is a near drop-in port.
 *
 * Pure + best-effort + additive: it never affects which edges are emitted.
 */
import type Parser from "tree-sitter";

export interface MethodSignature {
  readonly parameterCount: number | undefined;
  readonly returnType: string | undefined;
}

/** Parameter-list node types across the supported grammars. */
const PARAM_LIST_TYPES: ReadonlySet<string> = new Set([
  "formal_parameters", "parameters", "parameter_list",
  "function_parameters", "method_parameters", "function_value_parameters",
]);

/** Node types that directly denote a variadic/rest parameter. */
const VARIADIC_PARAM_TYPES: ReadonlySet<string> = new Set([
  "variadic_parameter_declaration", // Go: ...string
  "variadic_parameter",             // Rust: extern "C" fn(...)
  "spread_parameter",               // Java: Object... args
  "list_splat_pattern",             // Python: *args
  "dictionary_splat_pattern",       // Python: **kwargs
]);

/** A parameter that is the language's implicit receiver, not a real argument slot. */
function isReceiverParam(param: Parser.SyntaxNode): boolean {
  return (
    param.text === "self" || param.text === "&self" || param.text === "&mut self" ||
    param.type === "self_parameter"
  );
}

/**
 * The identifier text of a single parameter, best-effort across grammars
 * (`name` field, then a representative identifier/variable descendant, then the
 * raw text). Used only by {@link extractParameterNames} for the self-recursion
 * "no argument progress" check; an imperfect extraction simply fails the
 * positional equality (no false positive), never the reverse.
 */
function parameterIdentifierText(param: Parser.SyntaxNode): string {
  const named = param.childForFieldName("name");
  if (named) return named.text.trim();
  const idTypes = new Set([
    "identifier", "variable_name", "shorthand_property_identifier_pattern", "simple_identifier",
  ]);
  const descend = (n: Parser.SyntaxNode): Parser.SyntaxNode | undefined => {
    if (idTypes.has(n.type)) return n;
    for (const c of n.namedChildren) {
      const hit = descend(c);
      if (hit) return hit;
    }
    return undefined;
  };
  const id = descend(param);
  return (id ?? param).text.trim();
}

/**
 * Best-effort parameter identifier texts for a callable, aligned with
 * {@link extractMethodSignature}'s count (skips a receiver `self`; returns
 * `undefined` for variadic signatures or when no parameter list exists, so the
 * no-progress check is skipped rather than guessed).
 */
export function extractParameterNames(
  node: Parser.SyntaxNode | null | undefined,
): string[] | undefined {
  if (!node) return undefined;
  const parameterList: Parser.SyntaxNode | null =
    PARAM_LIST_TYPES.has(node.type) ? node : node.childForFieldName("parameters") ?? findParameterList(node);
  if (!parameterList || !PARAM_LIST_TYPES.has(parameterList.type)) return undefined;

  const names: string[] = [];
  for (const param of parameterList.namedChildren) {
    if (param.type === "comment") continue;
    if (isReceiverParam(param)) continue;
    if (VARIADIC_PARAM_TYPES.has(param.type)) return undefined; // variadic → not comparable
    if (param.type === "required_parameter" || param.type === "optional_parameter") {
      if (param.children.some((c) => c.type === "rest_pattern")) return undefined;
    }
    names.push(parameterIdentifierText(param));
  }
  return names;
}

/**
 * Find a parameter-list node by a two-pass walk: scan the direct children first
 * (shallow), then recurse into each child (deep). The shallow-before-deep order
 * matches the most-specific list (e.g. a C/C++ declarator's nested list).
 */
function findParameterList(current: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (const child of current.children) {
    if (PARAM_LIST_TYPES.has(child.type)) return child;
  }
  for (const child of current.children) {
    const nested = findParameterList(child);
    if (nested) return nested;
  }
  return null;
}

/**
 * Extract parameter count and return-type text from a callable AST node.
 * Returns `parameterCount: undefined` for variadic signatures and where no
 * recognizable parameter list exists; `returnType: undefined` where the grammar
 * annotates none (or it is `void`).
 */
export function extractMethodSignature(
  node: Parser.SyntaxNode | null | undefined,
): MethodSignature {
  // Start UNDEFINED (not 0): a node with no recognizable parameter list (e.g. a
  // class) must carry no `parameterCount`, matching the pre-Wave-2 behaviour so
  // the Symbol shape stays golden-identical for non-callables.
  let parameterCount: number | undefined;
  let returnType: string | undefined;
  let isVariadic = false;

  if (!node) return { parameterCount, returnType };

  const parameterList: Parser.SyntaxNode | null =
    PARAM_LIST_TYPES.has(node.type)
      ? node // node itself IS the parameter list (e.g. C# primary constructors)
      : node.childForFieldName("parameters") ?? findParameterList(node);

  if (parameterList && PARAM_LIST_TYPES.has(parameterList.type)) {
    // A parameter list exists → produce a definite count (0 for `()`), unless a
    // variadic param is found below (which sets it back to undefined).
    parameterCount = 0;
    for (const param of parameterList.namedChildren) {
      if (param.type === "comment") continue;
      // Skip a receiver/self parameter (Rust `&self`, Python `self`).
      if (param.text === "self" || param.text === "&self" || param.text === "&mut self" ||
          param.type === "self_parameter") {
        continue;
      }
      // Direct variadic node types (Go/Rust/Java/Python).
      if (VARIADIC_PARAM_TYPES.has(param.type)) {
        isVariadic = true;
        continue;
      }
      // TypeScript/JavaScript: rest parameter — a required/optional parameter
      // wrapping a `rest_pattern`.
      if (param.type === "required_parameter" || param.type === "optional_parameter") {
        for (const child of param.children) {
          if (child.type === "rest_pattern") {
            isVariadic = true;
            break;
          }
        }
        if (isVariadic) continue;
      }
      // Kotlin: a `vararg` modifier on a regular parameter (the modifier is a
      // previous sibling). Falls through, still counts this param.
      if (param.type === "parameter" || param.type === "formal_parameter") {
        const prev = param.previousSibling;
        if (prev?.type === "parameter_modifiers" && prev.text.includes("vararg")) {
          isVariadic = true;
        }
      }
      parameterCount++;
    }
    // C/C++: bare `...` token in the parameter list (not a named child).
    if (!isVariadic) {
      for (const child of parameterList.children) {
        if (!child.isNamed && child.text === "...") {
          isVariadic = true;
          break;
        }
      }
    }
  }

  // ── Return-type extraction (first non-empty wins) ────────────────────────
  // Go: the `result` field is either a single type node or a parameter_list
  // (multi-return like `(*User, error)`); take only the first return type.
  const goResult = node.childForFieldName("result");
  if (goResult) {
    if (goResult.type === "parameter_list") {
      const firstParam = goResult.firstNamedChild;
      if (firstParam?.type === "parameter_declaration") {
        const typeNode = firstParam.childForFieldName("type");
        if (typeNode) returnType = typeNode.text;
      } else if (firstParam) {
        // Unnamed return types `(string, error)` — first child is a bare type node.
        returnType = firstParam.text;
      }
    } else {
      returnType = goResult.text;
    }
  }

  // Rust: `return_type` field — the value IS the type node. Skip a
  // `type_annotation` (TS/Python), handled by the generic loop below.
  if (!returnType) {
    const rustReturn = node.childForFieldName("return_type");
    if (rustReturn && rustReturn.type !== "type_annotation") {
      returnType = rustReturn.text;
    }
  }

  // C/C++: `type` field on function_definition (`void` → undefined).
  if (!returnType) {
    const cppType = node.childForFieldName("type");
    if (cppType && cppType.text !== "void") {
      returnType = cppType.text;
    }
  }

  // C#: `returns` field on method_declaration (`void` → undefined).
  if (!returnType) {
    const csReturn = node.childForFieldName("returns");
    if (csReturn && csReturn.text !== "void") {
      returnType = csReturn.text;
    }
  }

  // Generic TS/Rust/Python/C#/Kotlin: a `type_annotation` or `return_type` child
  // — take the first named grandchild's text.
  if (!returnType) {
    for (const child of node.children) {
      if (child.type === "type_annotation" || child.type === "return_type") {
        const typeNode = child.children.find((c) => c.isNamed);
        if (typeNode) returnType = typeNode.text;
      }
    }
  }

  if (isVariadic) parameterCount = undefined;

  return { parameterCount, returnType };
}
