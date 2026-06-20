/**
 * E3 — response-shape extraction.
 *
 * `extractResponseKeys(handlerNode, language)` collects the TOP-LEVEL keys of
 * the JSON body a route handler returns. v1 recognises three idioms (JS/TS):
 *
 *   res.json({ ... })   res.send({ ... })   return { ... }
 *
 * It is a pure tree-sitter subtree walk (no I/O); the caller passes the live
 * handler `SyntaxNode`. Only top-level object keys are collected — nested
 * shapes are out of scope for v1. Keys are returned de-duplicated in first-seen
 * order so the persisted shape is deterministic.
 */
import type Parser from "tree-sitter";
import type { Language } from "../../../core/domain.js";

/** Method names whose first object-literal argument is treated as the body. */
const RESPONSE_SENDER_METHODS: ReadonlySet<string> = new Set(["json", "send"]);

/**
 * Collect the top-level keys of the response body returned by a handler node.
 *
 * @param handlerNode the route handler's tree-sitter node (function/method/arrow)
 * @param language    source language (v1 supports JS/TS; others return `[]`)
 */
export function extractResponseKeys(
  handlerNode: Parser.SyntaxNode,
  language: Language,
): string[] {
  if (language !== "typescript" && language !== "javascript") return [];

  const keys: string[] = [];
  const seen = new Set<string>();
  const pushKeys = (objectNode: Parser.SyntaxNode | null | undefined): void => {
    if (!objectNode || objectNode.type !== "object") return;
    for (const key of topLevelObjectKeys(objectNode)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  };

  walk(handlerNode, (node) => {
    // `return { ... }` — the returned expression is an object literal.
    if (node.type === "return_statement") {
      const expr = node.namedChildren.find((c) => c.type === "object");
      pushKeys(expr);
      return;
    }
    // `res.json({ ... })` / `res.send({ ... })` — a call on a member expression
    // whose property is `json`/`send` and whose first argument is an object.
    if (node.type === "call_expression") {
      const callee = node.childForFieldName("function");
      if (callee?.type !== "member_expression") return;
      const prop = callee.childForFieldName("property");
      if (!prop || !RESPONSE_SENDER_METHODS.has(prop.text)) return;
      const args = node.childForFieldName("arguments");
      const firstObject = args?.namedChildren.find((c) => c.type === "object");
      pushKeys(firstObject);
    }
  });

  return keys;
}

/** Top-level property keys of an `object` node (string/identifier/shorthand). */
function topLevelObjectKeys(objectNode: Parser.SyntaxNode): string[] {
  const out: string[] = [];
  for (const child of objectNode.namedChildren) {
    // pair: `key: value` (key is property_identifier / string / number).
    if (child.type === "pair") {
      const keyNode = child.childForFieldName("key") ?? child.namedChildren[0];
      const name = keyName(keyNode);
      if (name) out.push(name);
      continue;
    }
    // shorthand_property_identifier: `{ data }`.
    if (child.type === "shorthand_property_identifier") {
      out.push(child.text);
      continue;
    }
    // spread_element (`...rest`) and method_definition are not top-level keys.
  }
  return out;
}

/** Normalise a key node to its string name (strips quotes from string keys). */
function keyName(node: Parser.SyntaxNode | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "string") return node.text.replace(/^['"`]|['"`]$/g, "");
  if (node.type === "property_identifier" || node.type === "identifier") return node.text;
  if (node.type === "number") return node.text;
  return undefined;
}

/** Pre-order DFS over a tree-sitter subtree. */
function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
}
