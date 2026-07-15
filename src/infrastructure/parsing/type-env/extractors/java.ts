/**
 * Java type extractor (Wave 3, Tier B).
 *
 * Ported from the legacy parser (typocop's pre-refactor parser lineage) — the
 * Java half of the JVM config (the Kotlin half is deferred to Wave 7). Covers
 * `Type x = ...`, `var x = new User()` initializer inference, formal parameters,
 * and the `var x = Factory.create()` constructor-binding form.
 */
import type Parser from "tree-sitter";
import type {
  LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor,
  InitializerExtractor, ClassNameLookup, ConstructorBindingScanner,
} from "../types.js";
import { extractSimpleTypeName, extractVarName } from "../shared.js";

const JAVA_DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  "local_variable_declaration",
  "field_declaration",
]);

/** Java: `Type x = ...;`, `Type x;`. */
const extractJavaDeclaration: TypeBindingExtractor = (node, env) => {
  const typeNode = node.childForFieldName("type");
  if (!typeNode) return;
  const typeName = extractSimpleTypeName(typeNode);
  if (!typeName || typeName === "var") return; // skip Java 10 var — handled by initializer

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type !== "variable_declarator") continue;
    const nameNode = child.childForFieldName("name");
    if (nameNode) {
      const varName = extractVarName(nameNode);
      if (varName) env.set(varName, typeName);
    }
  }
};

/** Java 10+: `var x = new User()` — infer type from object_creation_expression. */
const extractJavaInitializer: InitializerExtractor = (node, env, _classNames: ClassNameLookup) => {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type !== "variable_declarator") continue;
    const nameNode = child.childForFieldName("name");
    const valueNode = child.childForFieldName("value");
    if (!nameNode || !valueNode) continue;
    // Skip declarators that already have a binding from extractDeclaration.
    const varName = extractVarName(nameNode);
    if (!varName || env.has(varName)) continue;
    if (valueNode.type !== "object_creation_expression") continue;
    const ctorType = valueNode.childForFieldName("type");
    if (!ctorType) continue;
    const typeName = extractSimpleTypeName(ctorType);
    if (typeName) env.set(varName, typeName);
  }
};

/** Java: formal_parameter → type name. */
const extractJavaParameter: ParameterExtractor = (node, env) => {
  let nameNode: Parser.SyntaxNode | null;
  let typeNode: Parser.SyntaxNode | null;

  if (node.type === "formal_parameter") {
    typeNode = node.childForFieldName("type");
    nameNode = node.childForFieldName("name");
  } else {
    nameNode = node.childForFieldName("name") ?? node.childForFieldName("pattern");
    typeNode = node.childForFieldName("type");
  }

  if (!nameNode || !typeNode) return;
  const varName = extractVarName(nameNode);
  const typeName = extractSimpleTypeName(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

/** Java: `var x = SomeFactory.create()` — constructor binding for `var` with method_invocation. */
const scanJavaConstructorBinding: ConstructorBindingScanner = (node) => {
  if (node.type !== "local_variable_declaration") return undefined;
  const typeNode = node.childForFieldName("type");
  if (!typeNode) return undefined;
  if (typeNode.text !== "var") return undefined;
  const declarator = node.namedChildren.find((c) => c.type === "variable_declarator");
  if (!declarator) return undefined;
  const nameNode = declarator.childForFieldName("name");
  const value = declarator.childForFieldName("value");
  if (!nameNode || !value) return undefined;
  if (value.type === "object_creation_expression") return undefined;
  if (value.type !== "method_invocation") return undefined;
  const methodName = value.childForFieldName("name");
  if (!methodName) return undefined;
  return { varName: nameNode.text, calleeName: methodName.text };
};

export const javaConfig: LanguageTypeConfig = {
  declarationNodeTypes: JAVA_DECLARATION_NODE_TYPES,
  extractDeclaration: extractJavaDeclaration,
  extractParameter: extractJavaParameter,
  extractInitializer: extractJavaInitializer,
  scanConstructorBinding: scanJavaConstructorBinding,
};
