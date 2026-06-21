/**
 * Class-container + function-name AST utilities (Wave 3, Tier B).
 *
 * Ported from the legacy parser (typocop's pre-refactor parser lineage), re-keyed
 * to typocop's raw tree-sitter `Parser.SyntaxNode`. Dependency-free of
 * `core/domain.ts`.
 *
 * `buildTypeEnv` consumes `CLASS_CONTAINER_TYPES` (class-name collection +
 * self/this resolution) and `extractFunctionName` (the `funcName` half of the
 * scope key). `CONTAINER_TYPE_TO_LABEL`/`findEnclosingClassId` are ported as part
 * of the unit (graph node-id derivation); `findEnclosingClassId` is not consumed
 * by the type-env and uses the ported label-keyed id format, kept local here.
 */
import type Parser from "tree-sitter";
import { FUNCTION_DECLARATION_TYPES } from "./constants.js";

/** Ported label-keyed id format (`Label:name[:line]`). Local to this module. */
const legacyNodeId = (label: string, name: string, lineNumber?: number): string =>
  lineNumber !== undefined ? `${label}:${name}:${lineNumber}` : `${label}:${name}`;

/** Tree-sitter node types that declare a class/struct/interface/impl container. */
export const CLASS_CONTAINER_TYPES: ReadonlySet<string> = new Set([
  "class_declaration", "abstract_class_declaration",
  "interface_declaration", "struct_declaration", "record_declaration",
  "class_specifier", "struct_specifier",
  "impl_item", "trait_item",
  "class_definition",
  "trait_declaration",
  "protocol_declaration",
  // Ruby
  "class",
  "module",
  // Kotlin
  "object_declaration",
  "companion_object",
]);

/** Map each container node type → its graph node-label string. */
export const CONTAINER_TYPE_TO_LABEL: Readonly<Record<string, string>> = {
  class_declaration: "Class",
  abstract_class_declaration: "Class",
  interface_declaration: "Interface",
  struct_declaration: "Struct",
  struct_specifier: "Struct",
  class_specifier: "Class",
  class_definition: "Class",
  impl_item: "Impl",
  trait_item: "Trait",
  trait_declaration: "Trait",
  record_declaration: "Record",
  protocol_declaration: "Interface",
  class: "Class",
  module: "Module",
  object_declaration: "Class",
  companion_object: "Class",
};

/**
 * Walk up the AST to find the enclosing class/struct/interface/impl, returning a
 * ported label-keyed id or `null`. For Go `method_declaration` nodes, extracts
 * the receiver type (`func (u *User) Save()` → User struct). Ported as part of
 * the unit; NOT consumed by `buildTypeEnv`.
 */
export const findEnclosingClassId = (
  node: Parser.SyntaxNode,
  filePath: string,
): string | null => {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === "method_declaration") {
      const receiver = current.childForFieldName("receiver");
      if (receiver) {
        const paramDecl = receiver.namedChildren.find((c) => c.type === "parameter_declaration");
        if (paramDecl) {
          const typeNode = paramDecl.childForFieldName("type");
          if (typeNode) {
            const inner = typeNode.type === "pointer_type" ? typeNode.firstNamedChild : typeNode;
            if (inner && (inner.type === "type_identifier" || inner.type === "identifier")) {
              return legacyNodeId("Struct", `${filePath}:${inner.text}`);
            }
          }
        }
      }
    }
    if (CLASS_CONTAINER_TYPES.has(current.type)) {
      if (current.type === "impl_item") {
        const children = current.children;
        const forIdx = children.findIndex((c) => c.text === "for");
        if (forIdx !== -1) {
          const nameNode = children.slice(forIdx + 1).find(
            (c) => c.type === "type_identifier" || c.type === "identifier",
          );
          if (nameNode) {
            return legacyNodeId("Impl", `${filePath}:${nameNode.text}`);
          }
        }
      }
      const nameNode = current.childForFieldName("name")
        ?? current.children.find(
          (c) => c.type === "type_identifier" || c.type === "identifier" ||
            c.type === "name" || c.type === "constant",
        );
      if (nameNode) {
        const label = CONTAINER_TYPE_TO_LABEL[current.type] ?? "Class";
        return legacyNodeId(label, `${filePath}:${nameNode.text}`);
      }
    }
    current = current.parent;
  }
  return null;
};

/**
 * Extract a function name + label from a function/method definition node.
 * Handles C/C++ `qualified_identifier` (`ClassName::MethodName`) and the
 * per-language declarator patterns. `buildTypeEnv` uses only `funcName` (to form
 * the `funcName@startIndex` scope key).
 */
export const extractFunctionName = (
  node: Parser.SyntaxNode,
): { funcName: string | null; label: string } => {
  let funcName: string | null = null;
  let label = "Function";

  if (node.type === "init_declaration" || node.type === "deinit_declaration") {
    return {
      funcName: node.type === "init_declaration" ? "init" : "deinit",
      label: "Constructor",
    };
  }

  if (FUNCTION_DECLARATION_TYPES.has(node.type)) {
    let declarator: Parser.SyntaxNode | null = node.childForFieldName("declarator")
      ?? node.children.find((c) => c.type === "function_declarator") ?? null;
    while (
      declarator &&
      (declarator.type === "pointer_declarator" || declarator.type === "reference_declarator")
    ) {
      declarator = declarator.childForFieldName("declarator")
        ?? declarator.children.find(
          (c) => c.type === "function_declarator" || c.type === "pointer_declarator" ||
            c.type === "reference_declarator",
        ) ?? null;
    }
    if (declarator) {
      const innerDeclarator: Parser.SyntaxNode | null = declarator.childForFieldName("declarator")
        ?? declarator.children.find(
          (c) => c.type === "qualified_identifier" || c.type === "identifier" ||
            c.type === "parenthesized_declarator",
        ) ?? null;

      if (innerDeclarator?.type === "qualified_identifier") {
        const nameNode = innerDeclarator.childForFieldName("name")
          ?? innerDeclarator.children.find((c) => c.type === "identifier");
        if (nameNode?.text) {
          funcName = nameNode.text;
          label = "Method";
        }
      } else if (innerDeclarator?.type === "identifier") {
        funcName = innerDeclarator.text;
      } else if (innerDeclarator?.type === "parenthesized_declarator") {
        const nestedId = innerDeclarator.children.find(
          (c) => c.type === "qualified_identifier" || c.type === "identifier",
        );
        if (nestedId?.type === "qualified_identifier") {
          const nameNode = nestedId.childForFieldName("name")
            ?? nestedId.children.find((c) => c.type === "identifier");
          if (nameNode?.text) {
            funcName = nameNode.text;
            label = "Method";
          }
        } else if (nestedId?.type === "identifier") {
          funcName = nestedId.text;
        }
      }
    }

    if (!funcName) {
      const nameNode = node.childForFieldName("name")
        ?? node.children.find(
          (c) => c.type === "identifier" || c.type === "property_identifier" ||
            c.type === "simple_identifier",
        );
      funcName = nameNode?.text ?? null;
    }
  } else if (node.type === "impl_item") {
    const funcItem = node.children.find((c) => c.type === "function_item");
    if (funcItem) {
      const nameNode = funcItem.childForFieldName("name")
        ?? funcItem.children.find((c) => c.type === "identifier");
      funcName = nameNode?.text ?? null;
      label = "Method";
    }
  } else if (node.type === "method_definition") {
    const nameNode = node.childForFieldName("name")
      ?? node.children.find((c) => c.type === "property_identifier");
    funcName = nameNode?.text ?? null;
    label = "Method";
  } else if (node.type === "method_declaration" || node.type === "constructor_declaration") {
    const nameNode = node.childForFieldName("name")
      ?? node.children.find((c) => c.type === "identifier");
    funcName = nameNode?.text ?? null;
    label = "Method";
  } else if (node.type === "arrow_function" || node.type === "function_expression") {
    const parent = node.parent;
    if (parent?.type === "variable_declarator") {
      const nameNode = parent.childForFieldName("name")
        ?? parent.children.find((c) => c.type === "identifier");
      funcName = nameNode?.text ?? null;
    }
  } else if (node.type === "method" || node.type === "singleton_method") {
    const nameNode = node.childForFieldName("name")
      ?? node.children.find((c) => c.type === "identifier");
    funcName = nameNode?.text ?? null;
    label = "Method";
  }

  return { funcName, label };
};
