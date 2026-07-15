/**
 * Go type extractor (Wave 3, Tier B).
 *
 * Ported from the legacy parser (typocop's pre-refactor parser lineage). Covers
 * `var x Foo`, `x := Foo{}` composite literals, `&Foo{}`, `new(Foo)`,
 * `make([]Foo, 0)`/`make(map[K]Foo)`, type assertions `iface.(Foo)`, and the
 * multi-return `x, err := NewFoo()` constructor-binding form.
 */
import type Parser from "tree-sitter";
import type {
  ConstructorBindingScanner, LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor,
} from "../types.js";
import { extractSimpleTypeName, extractVarName } from "../shared.js";

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  "var_declaration",
  "var_spec",
  "short_var_declaration",
]);

/** Go: `var x Foo`. */
const extractGoVarDeclaration = (node: Parser.SyntaxNode, env: Map<string, string>): void => {
  if (node.type === "var_declaration") {
    for (let i = 0; i < node.namedChildCount; i++) {
      const spec = node.namedChild(i);
      if (spec?.type === "var_spec") extractGoVarDeclaration(spec, env);
    }
    return;
  }

  // var_spec: name type [= value]
  const nameNode = node.childForFieldName("name");
  const typeNode = node.childForFieldName("type");
  if (!nameNode || !typeNode) return;
  const varName = extractVarName(nameNode);
  const typeName = extractSimpleTypeName(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

/** Go: `x := Foo{...}` — infer from composite literal (handles multi-assignment). */
const extractGoShortVarDeclaration = (node: Parser.SyntaxNode, env: Map<string, string>): void => {
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  if (!left || !right) return;

  const lhsNodes: Parser.SyntaxNode[] = [];
  const rhsNodes: Parser.SyntaxNode[] = [];

  if (left.type === "expression_list") {
    for (let i = 0; i < left.namedChildCount; i++) {
      const c = left.namedChild(i);
      if (c) lhsNodes.push(c);
    }
  } else {
    lhsNodes.push(left);
  }

  if (right.type === "expression_list") {
    for (let i = 0; i < right.namedChildCount; i++) {
      const c = right.namedChild(i);
      if (c) rhsNodes.push(c);
    }
  } else {
    rhsNodes.push(right);
  }

  const count = Math.min(lhsNodes.length, rhsNodes.length);
  for (let i = 0; i < count; i++) {
    let valueNode = rhsNodes[i];
    // Unwrap `&User{}` — unary_expression (address-of) wrapping composite_literal.
    if (valueNode.type === "unary_expression" &&
        valueNode.firstNamedChild?.type === "composite_literal") {
      valueNode = valueNode.firstNamedChild;
    }
    // Go built-ins: new(User) / make([]User, 0) / make(map[string]User).
    if (valueNode.type === "call_expression") {
      const funcNode = valueNode.childForFieldName("function");
      if (funcNode?.text === "new") {
        const args = valueNode.childForFieldName("arguments");
        if (args?.firstNamedChild) {
          const typeName = extractSimpleTypeName(args.firstNamedChild);
          const varName = extractVarName(lhsNodes[i]);
          if (varName && typeName) env.set(varName, typeName);
        }
      } else if (funcNode?.text === "make") {
        const args = valueNode.childForFieldName("arguments");
        const firstArg = args?.firstNamedChild;
        if (firstArg) {
          let innerType: Parser.SyntaxNode | null = null;
          if (firstArg.type === "slice_type") {
            innerType = firstArg.childForFieldName("element");
          } else if (firstArg.type === "map_type") {
            innerType = firstArg.childForFieldName("value");
          }
          if (innerType) {
            const typeName = extractSimpleTypeName(innerType);
            const varName = extractVarName(lhsNodes[i]);
            if (varName && typeName) env.set(varName, typeName);
          }
        }
      }
      continue;
    }
    // Go type assertion: `user := iface.(User)`.
    if (valueNode.type === "type_assertion_expression") {
      const typeNode = valueNode.childForFieldName("type");
      if (typeNode) {
        const typeName = extractSimpleTypeName(typeNode);
        const varName = extractVarName(lhsNodes[i]);
        if (varName && typeName) env.set(varName, typeName);
      }
      continue;
    }
    if (valueNode.type !== "composite_literal") continue;
    const typeNode = valueNode.childForFieldName("type");
    if (!typeNode) continue;
    const typeName = extractSimpleTypeName(typeNode);
    if (!typeName) continue;
    const varName = extractVarName(lhsNodes[i]);
    if (varName) env.set(varName, typeName);
  }
};

const extractDeclaration: TypeBindingExtractor = (node, env) => {
  if (node.type === "var_declaration" || node.type === "var_spec") {
    extractGoVarDeclaration(node, env);
  } else if (node.type === "short_var_declaration") {
    extractGoShortVarDeclaration(node, env);
  }
};

/** Go: parameter → name type. */
const extractParameter: ParameterExtractor = (node, env) => {
  let nameNode: Parser.SyntaxNode | null;
  let typeNode: Parser.SyntaxNode | null;

  if (node.type === "parameter") {
    nameNode = node.childForFieldName("name");
    typeNode = node.childForFieldName("type");
  } else {
    nameNode = node.childForFieldName("name") ?? node.childForFieldName("pattern");
    typeNode = node.childForFieldName("type");
  }

  if (!nameNode || !typeNode) return;
  const varName = extractVarName(nameNode);
  const typeName = extractSimpleTypeName(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

/** Go: `user := NewUser(...)` / `user, err := NewUser()` — infer from the call's return. */
const scanConstructorBinding: ConstructorBindingScanner = (node) => {
  if (node.type !== "short_var_declaration") return undefined;
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  if (!left || !right) return undefined;
  const leftIds = left.type === "expression_list" ? left.namedChildren : [left];
  const rightExprs = right.type === "expression_list" ? right.namedChildren : [right];

  // Multi-return: `user, err := NewUser()` — bind first var when second is err/ok/_.
  if (leftIds.length === 2 && rightExprs.length === 1) {
    const secondVar = leftIds[1];
    const isErrorOrDiscard =
      secondVar.text === "_" || secondVar.text === "err" ||
      secondVar.text === "ok" || secondVar.text === "error";
    if (isErrorOrDiscard && leftIds[0].type === "identifier") {
      if (rightExprs[0].type !== "call_expression") return undefined;
      const func = rightExprs[0].childForFieldName("function");
      if (!func) return undefined;
      if (func.text === "new" || func.text === "make") return undefined;
      const calleeName = extractSimpleTypeName(func);
      if (!calleeName) return undefined;
      return { varName: leftIds[0].text, calleeName };
    }
  }

  // Single assignment only.
  if (leftIds.length !== 1 || leftIds[0].type !== "identifier") return undefined;
  if (rightExprs.length !== 1 || rightExprs[0].type !== "call_expression") return undefined;
  const func = rightExprs[0].childForFieldName("function");
  if (!func) return undefined;
  // Skip new()/make() — already handled by extractDeclaration.
  if (func.text === "new" || func.text === "make") return undefined;
  const calleeName = extractSimpleTypeName(func);
  if (!calleeName) return undefined;
  return { varName: leftIds[0].text, calleeName };
};

export const goConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  extractDeclaration,
  extractParameter,
  scanConstructorBinding,
};
