/**
 * Per-language export detection (Wave 2, 1.3).
 *
 * Determines whether a symbol (function, class, etc.) is exported/public in its
 * language — a signal ORTHOGONAL to `visibility` (the access-modifier axis).
 * Pure + worker-thread-safe; AST-shape + name-string driven only.
 *
 * The dispatch table is `satisfies Record<Language, ExportChecker>`, so a
 * missing `Language` literal is a COMPILE error (exhaustiveness is the desirable
 * safety property here).
 *
 * Ported from the legacy parser's `export-detection.ts`. Re-keyed from its
 * `SupportedLanguages` enum to typocop's lowercase `Language` union; its Kotlin
 * checker is dropped (typocop's union has no `kotlin`), which also drops the only
 * dependency on its `findSiblingChild` helper.
 */
import type Parser from "tree-sitter";
import type { Language } from "../../core/domain.js";

/** Given a node and symbol name, returns true if the symbol is exported/public. */
type ExportChecker = (node: Parser.SyntaxNode, name: string) => boolean;

// ── Per-language export checkers ───────────────────────────────────────────

/** JS/TS: walk ancestors looking for an export statement/specifier. */
const tsExportChecker: ExportChecker = (node, _name) => {
  let current: Parser.SyntaxNode | null = node;
  while (current) {
    const type = current.type;
    if (type === "export_statement" ||
        type === "export_specifier" ||
        (type === "lexical_declaration" && current.parent?.type === "export_statement")) {
      return true;
    }
    // Fallback for edge cases: the node text starts with `export `. Restricted
    // to the STARTING node (and never the file root) — walking the ancestor
    // chain up to `program`/`module` would otherwise false-positive on every
    // symbol in a file whose FIRST statement happens to be an `export`.
    if (current === node && type !== "program" && type !== "module" &&
        current.text?.startsWith("export ")) {
      return true;
    }
    current = current.parent;
  }
  return false;
};

/** Python: public if no leading underscore (convention). */
const pythonExportChecker: ExportChecker = (_node, name) => !name.startsWith("_");

/**
 * Java: a `public` modifier. The `modifiers` node is a CHILD of the declaration
 * node (and thus a sibling of the name node). Scan the current node's own
 * children AND its parent's children so the checker works whether it is handed
 * the declaration node directly (typocop) or the inner name node.
 */
const hasPublicModifierChild = (n: Parser.SyntaxNode | null): boolean => {
  if (!n) return false;
  for (let i = 0; i < n.childCount; i++) {
    const child = n.child(i);
    if (child?.type === "modifiers" && child.text?.includes("public")) return true;
  }
  return false;
};

const javaExportChecker: ExportChecker = (node, _name) => {
  let current: Parser.SyntaxNode | null = node;
  while (current) {
    if (hasPublicModifierChild(current) || hasPublicModifierChild(current.parent)) {
      return true;
    }
    if (current.type === "method_declaration" || current.type === "constructor_declaration") {
      if (current.text?.trimStart().startsWith("public")) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
};

/** C# declaration node types for sibling-modifier scanning. */
const CSHARP_DECL_TYPES: ReadonlySet<string> = new Set([
  "method_declaration", "local_function_statement", "constructor_declaration",
  "class_declaration", "interface_declaration", "struct_declaration",
  "enum_declaration", "record_declaration", "record_struct_declaration",
  "record_class_declaration", "delegate_declaration",
  "property_declaration", "field_declaration", "event_declaration",
  "namespace_declaration", "file_scoped_namespace_declaration",
]);

/**
 * C#: `modifier` nodes are SIBLINGS of the name node inside the declaration.
 * Walk up to the first declaration node, then scan its direct children.
 */
const csharpExportChecker: ExportChecker = (node, _name) => {
  let current: Parser.SyntaxNode | null = node;
  while (current) {
    if (CSHARP_DECL_TYPES.has(current.type)) {
      for (let i = 0; i < current.childCount; i++) {
        const child = current.child(i);
        if (child?.type === "modifier" && child.text === "public") return true;
      }
      return false;
    }
    current = current.parent;
  }
  return false;
};

/** Go: an uppercase first letter = exported. */
const goExportChecker: ExportChecker = (_node, name) => {
  if (name.length === 0) return false;
  const first = name[0];
  return first === first.toUpperCase() && first !== first.toLowerCase();
};

/** Rust declaration node types for sibling visibility_modifier scanning. */
const RUST_DECL_TYPES: ReadonlySet<string> = new Set([
  "function_item", "struct_item", "enum_item", "trait_item", "impl_item",
  "union_item", "type_item", "const_item", "static_item", "mod_item",
  "use_declaration", "associated_type", "function_signature_item",
]);

/**
 * Rust: a `visibility_modifier` is a SIBLING of the name node within the
 * declaration node (function_item, struct_item, etc.). Walk up to the
 * declaration node, then scan its direct children for a `pub*` modifier.
 */
const rustExportChecker: ExportChecker = (node, _name) => {
  let current: Parser.SyntaxNode | null = node;
  while (current) {
    if (RUST_DECL_TYPES.has(current.type)) {
      for (let i = 0; i < current.childCount; i++) {
        const child = current.child(i);
        if (child?.type === "visibility_modifier" && child.text?.startsWith("pub")) return true;
      }
      return false;
    }
    current = current.parent;
  }
  return false;
};

/**
 * C/C++: functions without a `static` storage class have external linkage by
 * default (≈ exported). Only `static` functions are file-scoped. C++ anonymous
 * namespaces (`namespace { ... }`) also give internal linkage.
 */
const cCppExportChecker: ExportChecker = (node, _name) => {
  let cur: Parser.SyntaxNode | null = node;
  while (cur) {
    if (cur.type === "function_definition" || cur.type === "declaration") {
      // Look for a `static` storage class specifier as a direct child node
      // (avoids reading the full — potentially huge — function text).
      for (let i = 0; i < cur.childCount; i++) {
        const child = cur.child(i);
        if (child?.type === "storage_class_specifier" && child.text === "static") return false;
      }
    }
    // C++ anonymous namespace: a namespace_definition with no `name` field.
    if (cur.type === "namespace_definition") {
      const hasName = cur.childForFieldName("name");
      if (!hasName) return false;
    }
    cur = cur.parent;
  }
  return true; // Top-level C/C++ functions default to external linkage.
};

/** PHP: a visibility modifier, or top-level (globally accessible). */
const phpExportChecker: ExportChecker = (node, _name) => {
  let current: Parser.SyntaxNode | null = node;
  while (current) {
    if (current.type === "class_declaration" ||
        current.type === "interface_declaration" ||
        current.type === "trait_declaration" ||
        current.type === "enum_declaration") {
      return true;
    }
    if (current.type === "visibility_modifier") {
      return current.text === "public";
    }
    current = current.parent;
  }
  // Top-level functions are globally accessible.
  return true;
};

/**
 * Swift: a `public` or `open` access modifier. The `modifiers` node is a CHILD
 * of the declaration node, so check both the node-as-ancestor (when handed an
 * inner node) AND the current node's own `modifiers`/`visibility_modifier`
 * children (when handed the declaration node, as typocop does).
 */
const swiftExportChecker: ExportChecker = (node, _name) => {
  const isPublicMod = (n: Parser.SyntaxNode): boolean => {
    if (n.type === "modifiers" || n.type === "visibility_modifier") {
      const text = n.text || "";
      if (text.includes("public") || text.includes("open")) return true;
    }
    return false;
  };
  let current: Parser.SyntaxNode | null = node;
  while (current) {
    if (isPublicMod(current)) return true;
    for (let i = 0; i < current.childCount; i++) {
      const child = current.child(i);
      if (child && isPublicMod(child)) return true;
    }
    current = current.parent;
  }
  return false;
};

/** Ruby: methods/classes are reachable by default. */
const rubyExportChecker: ExportChecker = (_node, _name) => true;

// ── Exhaustive dispatch table ──────────────────────────────────────────────
// `satisfies Record<Language, ExportChecker>` makes a missing language literal a
// COMPILE error. Re-keyed from the legacy parser's enum: note `cpp` (not
// `CPlusPlus`) and `csharp` (not `CSharp` / its `c_sharp` runtime value); the
// legacy `kotlin` checker is dropped (typocop's union has no Kotlin).
const exportCheckers = {
  typescript: tsExportChecker,
  javascript: tsExportChecker,
  python: pythonExportChecker,
  java: javaExportChecker,
  csharp: csharpExportChecker,
  go: goExportChecker,
  rust: rustExportChecker,
  cpp: cCppExportChecker,
  c: cCppExportChecker,
  php: phpExportChecker,
  swift: swiftExportChecker,
  ruby: rubyExportChecker,
} satisfies Record<Language, ExportChecker>;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Check whether a tree-sitter node is exported/public in its language.
 * Unknown language ⇒ `false` (defensive).
 */
export function isNodeExported(
  node: Parser.SyntaxNode,
  name: string,
  language: Language,
): boolean {
  const checker = exportCheckers[language];
  if (!checker) return false;
  return checker(node, name);
}
