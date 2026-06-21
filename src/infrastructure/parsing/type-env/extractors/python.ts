/**
 * Python type extractor (Wave 3, Tier B).
 *
 * Ported from the legacy parser (typocop's pre-refactor parser lineage). Covers
 * PEP 484 `x: Foo = ...`, the walrus operator, and CLASS-VERIFIED constructor
 * inference (Python ctors are syntactically identical to calls, so `User()` only
 * binds when `User` is a known class name).
 */
import type Parser from "tree-sitter";
import type {
  LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor,
  InitializerExtractor, ClassNameLookup, ConstructorBindingScanner,
} from "../types.js";
import { extractSimpleTypeName, extractVarName } from "../shared.js";

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  "assignment",
  "named_expression",
]);

/** Python: `x: Foo = ...` (PEP 484 annotations). */
const extractDeclaration: TypeBindingExtractor = (node, env) => {
  const left = node.childForFieldName("left");
  const typeNode = node.childForFieldName("type");
  if (!left || !typeNode) return;
  const varName = extractVarName(left);
  const typeName = extractSimpleTypeName(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

/** Python: parameter with type annotation. */
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

/**
 * Python: `user = User("alice")` — infer type from a call when the callee is a
 * known class. Verified against `classNames` (may include cross-file SymbolTable
 * lookups). Also handles the walrus operator `(user := User("alice"))`.
 */
const extractInitializer: InitializerExtractor = (node, env, classNames: ClassNameLookup) => {
  let left: Parser.SyntaxNode | null;
  let right: Parser.SyntaxNode | null;

  if (node.type === "named_expression") {
    left = node.childForFieldName("name");
    right = node.childForFieldName("value");
  } else if (node.type === "assignment") {
    left = node.childForFieldName("left");
    right = node.childForFieldName("right");
    // Skip if already annotated — extractDeclaration handled it.
    if (node.childForFieldName("type")) return;
  } else {
    return;
  }

  if (!left || !right) return;
  const varName = extractVarName(left);
  if (!varName || env.has(varName)) return;
  if (right.type !== "call") return;
  const func = right.childForFieldName("function");
  if (!func) return;
  // Support both direct calls (`User()`) and qualified calls (`models.User()`).
  const calleeName = extractSimpleTypeName(func);
  if (!calleeName) return;
  if (classNames.has(calleeName)) {
    env.set(varName, calleeName);
  }
};

/**
 * Python: `user = User("alice")` — scan assignment/walrus for constructor-like
 * calls WITHOUT the classNames check (caller validates against the SymbolTable).
 */
const scanConstructorBinding: ConstructorBindingScanner = (node) => {
  let left: Parser.SyntaxNode | null;
  let right: Parser.SyntaxNode | null;

  if (node.type === "named_expression") {
    left = node.childForFieldName("name");
    right = node.childForFieldName("value");
  } else if (node.type === "assignment") {
    left = node.childForFieldName("left");
    right = node.childForFieldName("right");
    if (node.childForFieldName("type")) return undefined;
  } else {
    return undefined;
  }

  if (!left || !right) return undefined;
  if (left.type !== "identifier") return undefined;
  if (right.type !== "call") return undefined;
  const func = right.childForFieldName("function");
  if (!func) return undefined;
  const calleeName = extractSimpleTypeName(func);
  if (!calleeName) return undefined;
  return { varName: left.text, calleeName };
};

export const pythonConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  extractDeclaration,
  extractParameter,
  extractInitializer,
  scanConstructorBinding,
};
