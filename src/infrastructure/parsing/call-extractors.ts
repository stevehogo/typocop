/**
 * Call-site classifiers (Wave 4, Task 1).
 *
 * Ported from the legacy parser (typocop's pre-refactor parser lineage). Two
 * cheap, grammar-agnostic helpers that run on the RAW tree-sitter
 * `Parser.SyntaxNode` of a call site, so they can be computed in Phase 2 and
 * stamped onto the `call` hint as additive `argCount` / `callForm` fields:
 *
 *   - {@link countCallArguments} — direct argument count (or `undefined` when the
 *     argument container can't be located cheaply — the signal that downstream
 *     arity filtering must be SKIPPED, never coerced to `0`).
 *   - {@link inferCallForm} — `free` / `member` / `constructor` discrimination by
 *     node type (no query change needed; the distinction is structural).
 *
 * Both operate directly on `Parser.SyntaxNode` (`childForFieldName` / `children`
 * / `isNamed`) — NOT the `ASTNode` wrapper, which lacks those accessors.
 */
import type Parser from "tree-sitter";

type Node = Parser.SyntaxNode;

/** Call-site call form. Mirrors the legacy parser's `CallForm`. */
export type CallForm = "free" | "member" | "constructor";

/**
 * Argument-list container node types across the supported grammars. A call's
 * direct argument count is the number of NAMED, non-comment children of one of
 * these.
 */
const CALL_ARGUMENT_LIST_TYPES = new Set(["arguments", "argument_list", "value_arguments"]);

/**
 * Count direct arguments for a call expression across common tree-sitter
 * grammars. Returns `undefined` (never `0`) when the argument container cannot
 * be located cheaply — that `undefined` is load-bearing: it tells the resolver's
 * arity filter to skip arity narrowing entirely rather than wrongly filter to
 * zero-arg overloads.
 *
 * - Counts only `isNamed` children and skips `comment` nodes, so trailing-comma
 *   / commented-out arguments don't inflate the count.
 * - Handles the Kotlin/Swift `call_expression → call_suffix → value_arguments`
 *   nesting by searching one level deeper through named children.
 */
export const countCallArguments = (callNode: Node | null | undefined): number | undefined => {
  if (!callNode) return undefined;

  // Direct field or direct child (most languages).
  let argsNode: Node | null | undefined =
    callNode.childForFieldName("arguments") ??
    callNode.children.find((child) => CALL_ARGUMENT_LIST_TYPES.has(child.type));

  // Kotlin/Swift: call_expression → call_suffix → value_arguments. Search one
  // level deeper through named children for grammars that wrap arguments in a
  // suffix node.
  if (!argsNode) {
    for (const child of callNode.children) {
      if (!child.isNamed) continue;
      const nested = child.children.find((gc) => CALL_ARGUMENT_LIST_TYPES.has(gc.type));
      if (nested) {
        argsNode = nested;
        break;
      }
    }
  }

  if (!argsNode) return undefined;

  let count = 0;
  for (const child of argsNode.children) {
    if (!child.isNamed) continue;
    if (child.type === "comment") continue;
    count++;
  }

  return count;
};

/**
 * AST node types that indicate a member-access wrapper around the callee name.
 * When `nameNode.parent.type` is one of these, the call is a member call.
 */
const MEMBER_ACCESS_NODE_TYPES = new Set([
  "member_expression", // TS/JS: obj.method()
  "attribute", // Python: obj.method()
  "member_access_expression", // C#: obj.Method()
  "field_expression", // Rust/C++: obj.method() / ptr->method()
  "selector_expression", // Go: obj.Method()
  "navigation_suffix", // Kotlin/Swift: obj.method() — nameNode sits inside navigation_suffix
  "member_binding_expression", // C#: user?.Method() — null-conditional access
]);

/**
 * Call node types that are inherently constructor invocations. Only patterns the
 * tree-sitter queries already capture as `@call`.
 */
const CONSTRUCTOR_CALL_NODE_TYPES = new Set([
  "constructor_invocation", // Kotlin: Foo()
  "new_expression", // TS/JS/C++: new Foo()
  "object_creation_expression", // Java/C#/PHP: new Foo()
  "implicit_object_creation_expression", // C# 9: User u = new(...)
  "composite_literal", // Go: User{...}
  "struct_expression", // Rust: User { ... }
]);

/** AST node types for scoped/qualified calls (Rust `Foo::new()`, C++ `ns::func()`). */
const SCOPED_CALL_NODE_TYPES = new Set([
  "scoped_identifier", // Rust: Foo::new()
  "qualified_identifier", // C++: ns::func()
]);

/**
 * Infer whether a captured call site is a free call, member call, or
 * constructor. Returns `undefined` if the form cannot be determined.
 *
 * Works by inspecting the AST structure between the call node (`@call`) and the
 * name node (`@call.name`). No tree-sitter query change is needed — the
 * distinction is in the node types. The decision cascade order is load-bearing:
 * first match wins.
 */
export const inferCallForm = (callNode: Node, nameNode: Node): CallForm | undefined => {
  // 1. Constructor: callNode itself is a constructor invocation.
  if (CONSTRUCTOR_CALL_NODE_TYPES.has(callNode.type)) {
    return "constructor";
  }

  // 2. Member call: nameNode's parent is a member-access wrapper.
  const nameParent = nameNode.parent;
  if (nameParent && MEMBER_ACCESS_NODE_TYPES.has(nameParent.type)) {
    return "member";
  }

  // 3. PHP: the callNode itself distinguishes member vs free calls.
  if (callNode.type === "member_call_expression" || callNode.type === "nullsafe_member_call_expression") {
    return "member";
  }
  if (callNode.type === "scoped_call_expression") {
    return "member"; // static call Foo::bar()
  }

  // 4. Java method_invocation: member if it has an 'object' field.
  if (callNode.type === "method_invocation" && callNode.childForFieldName("object")) {
    return "member";
  }

  // 4b. Ruby call with receiver: obj.method.
  if (callNode.type === "call" && callNode.childForFieldName("receiver")) {
    return "member";
  }

  // 5. Scoped calls (Rust `Foo::new()`, C++ `ns::func()`): treat as free.
  if (nameParent && SCOPED_CALL_NODE_TYPES.has(nameParent.type)) {
    return "free";
  }

  // 6. Default: if nameNode is a direct child of callNode, it's a free call.
  if (nameNode.parent === callNode || nameParent?.parent === callNode) {
    return "free";
  }

  return undefined;
};
