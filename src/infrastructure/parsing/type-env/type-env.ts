/**
 * Per-file scoped type environment (Wave 3, Tier B).
 *
 * Ported from the legacy parser (typocop's pre-refactor parser lineage), re-keyed
 * to typocop's raw tree-sitter `Parser.SyntaxNode` and lowercase `Language`
 * union. A single AST walk produces a `(scope, varName) → bareTypeName` map plus
 * the unverified cross-file constructor bindings, and resolves
 * `self`/`this`/`super`/`parent` via AST walks.
 *
 * Design constraints (unchanged from the legacy parser):
 * - Explicit-only: type annotations + class-verified constructor inference,
 *   never speculative flow inference.
 * - Scope-aware: function-local variables don't collide across functions
 *   (the `funcName@startIndex` scope key).
 * - Conservative: complex/generic types extract the base name only.
 * - Per-file: built once, used for receiver resolution, then discarded.
 */
import type Parser from "tree-sitter";
import type { Language } from "../../../core/domain.js";
import { FUNCTION_NODE_TYPES } from "./constants.js";
import { extractFunctionName, CLASS_CONTAINER_TYPES } from "./ast-utils.js";
import { typeConfigs } from "./extractors/index.js";
import { TYPED_PARAMETER_TYPES, extractSimpleTypeName } from "./shared.js";
import type { ClassNameLookup, LanguageTypeConfig } from "./types.js";

/** Scope → varName → bareTypeName. Outer key is the scope key; inner is var→type. */
export type TypeEnv = Map<string, Map<string, string>>;

/** File-level scope key. */
const FILE_SCOPE = "";

/**
 * Cross-file class-name source for constructor verification. typocop adapts this
 * over `SymbolTable.lookupFuzzy(name).some(d => d.type === 'class')` (LOWERCASE
 * kind — the documented API difference vs the legacy parser's `'Class'`). Only
 * `.has(name)` is exposed (the SymbolTable has no iteration). Optional — Phase 2
 * passes `localClassNames` only.
 */
export interface ClassNameSource {
  has(name: string): boolean;
}

/**
 * Unverified constructor binding: a `var x = Callee()` pattern where the callee
 * couldn't be locally confirmed a class (it may be defined in another file). The
 * caller must verify `calleeName` against the SymbolTable before trusting it.
 */
export interface ConstructorBinding {
  /** Function scope key (matches TypeEnv scope keys). */
  readonly scope: string;
  /** Variable name that received the constructor result. */
  readonly varName: string;
  /** Name of the callee (potential class constructor). */
  readonly calleeName: string;
  /** Enclosing class name when callee is a method on a known receiver (e.g. `$this`). */
  readonly receiverClassName?: string;
}

/**
 * Per-file type environment with receiver resolution. Built once per file via
 * {@link buildTypeEnv}, used for receiver-type filtering, then discarded.
 */
export interface TypeEnvironment {
  /** Look up a variable's resolved type, with self/this/super AST resolution. */
  lookup(varName: string, callNode: Parser.SyntaxNode): string | undefined;
  /** Unverified cross-file constructor bindings for SymbolTable verification. */
  readonly constructorBindings: readonly ConstructorBinding[];
  /** Raw per-scope type bindings — for testing and debugging. */
  readonly env: TypeEnv;
}

/**
 * Fallback for grammars where the class name is a `type_identifier` child rather
 * than a `name` field (e.g. Kotlin). Linear scan for the first such child.
 */
const findTypeIdentifierChild = (node: Parser.SyntaxNode): Parser.SyntaxNode | null => {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === "type_identifier") return child;
  }
  return null;
};

/** The lookup algorithm — shared between the closure and direct env use. */
const lookupInEnv = (
  env: TypeEnv,
  varName: string,
  callNode: Parser.SyntaxNode,
): string | undefined => {
  // Self/this receiver: resolve to the enclosing class name via AST walk.
  if (varName === "self" || varName === "this" || varName === "$this") {
    return findEnclosingClassName(callNode);
  }

  // Super/base/parent receiver: resolve to the parent class via AST walk.
  if (varName === "super" || varName === "base" || varName === "parent") {
    return findEnclosingParentClassName(callNode);
  }

  const scopeKey = findEnclosingScopeKey(callNode);

  // Function-local scope first.
  if (scopeKey) {
    const scopeEnv = env.get(scopeKey);
    if (scopeEnv) {
      const result = scopeEnv.get(varName);
      if (result) return result;
    }
  }

  // Fall back to file-level scope.
  const fileEnv = env.get(FILE_SCOPE);
  return fileEnv?.get(varName);
};

/** Walk up to the enclosing class/module name (resolves `self`/`this`). */
const findEnclosingClassName = (node: Parser.SyntaxNode): string | undefined => {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (CLASS_CONTAINER_TYPES.has(current.type)) {
      const nameNode = current.childForFieldName("name") ?? findTypeIdentifierChild(current);
      if (nameNode) return nameNode.text;
    }
    current = current.parent;
  }
  return undefined;
};

/** Walk up to the enclosing class, then extract its parent (resolves `super`/`parent`). */
const findEnclosingParentClassName = (node: Parser.SyntaxNode): string | undefined => {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (CLASS_CONTAINER_TYPES.has(current.type)) {
      return extractParentClassFromNode(current);
    }
    current = current.parent;
  }
  return undefined;
};

/**
 * Extract the parent/superclass name from a class declaration node. Heritage
 * extraction for all grammars (kept whole — harmless for unregistered langs).
 */
const extractParentClassFromNode = (classNode: Parser.SyntaxNode): string | undefined => {
  // 1. Named fields: Java/Ruby (superclass), Python (superclasses).
  const superclassNode = classNode.childForFieldName("superclass");
  if (superclassNode) {
    const inner = superclassNode.childForFieldName("type")
      ?? superclassNode.firstNamedChild
      ?? superclassNode;
    return extractSimpleTypeName(inner) ?? inner.text;
  }

  const superclassesNode = classNode.childForFieldName("superclasses");
  if (superclassesNode) {
    const first = superclassesNode.firstNamedChild;
    if (first) return extractSimpleTypeName(first) ?? first.text;
  }

  // 2. Unnamed children: walk the class node's children for heritage nodes.
  for (let i = 0; i < classNode.childCount; i++) {
    const child = classNode.child(i);
    if (!child) continue;

    switch (child.type) {
      // TS: class_heritage > extends_clause > type_identifier; JS: direct identifier.
      case "class_heritage": {
        for (let j = 0; j < child.childCount; j++) {
          const clause = child.child(j);
          if (clause?.type === "extends_clause") {
            const typeNode = clause.firstNamedChild;
            if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text;
          }
          if (clause?.type === "identifier" || clause?.type === "type_identifier") {
            return clause.text;
          }
        }
        break;
      }

      // C#: base_list > identifier or generic_name > identifier.
      case "base_list": {
        const first = child.firstNamedChild;
        if (first) {
          if (first.type === "generic_name") {
            const inner = first.childForFieldName("name") ?? first.firstNamedChild;
            if (inner) return inner.text;
          }
          return first.text;
        }
        break;
      }

      // PHP: base_clause > name.
      case "base_clause": {
        const name = child.firstNamedChild;
        if (name) return name.text;
        break;
      }

      // C++: base_class_clause > type_identifier.
      case "base_class_clause": {
        for (let j = 0; j < child.childCount; j++) {
          const inner = child.child(j);
          if (inner?.type === "type_identifier") return inner.text;
        }
        break;
      }

      // Kotlin: delegation_specifier > constructor_invocation > user_type > type_identifier.
      case "delegation_specifier": {
        const delegate = child.firstNamedChild;
        if (delegate?.type === "constructor_invocation") {
          const userType = delegate.firstNamedChild;
          if (userType?.type === "user_type") {
            const typeId = userType.firstNamedChild;
            if (typeId) return typeId.text;
          }
        }
        if (delegate?.type === "user_type") {
          const typeId = delegate.firstNamedChild;
          if (typeId) return typeId.text;
        }
        break;
      }

      // Swift: inheritance_specifier > user_type > type_identifier.
      case "inheritance_specifier": {
        const userType = child.childForFieldName("inherits_from") ?? child.firstNamedChild;
        if (userType?.type === "user_type") {
          const typeId = userType.firstNamedChild;
          if (typeId) return typeId.text;
        }
        break;
      }
    }
  }

  return undefined;
};

/** THE scope-key producer: walk up to the enclosing function → `funcName@startIndex`. */
const findEnclosingScopeKey = (node: Parser.SyntaxNode): string | undefined => {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      const { funcName } = extractFunctionName(current);
      if (funcName) return `${funcName}@${current.startIndex}`;
    }
    current = current.parent;
  }
  return undefined;
};

/**
 * Build a `ClassNameLookup` from local AST class names plus an optional cross-file
 * source. Memoized to avoid redundant `lookupFuzzy` scans across declarations.
 */
const createClassNameLookup = (
  localNames: Set<string>,
  source?: ClassNameSource,
): ClassNameLookup => {
  if (!source) return localNames;

  const memo = new Map<string, boolean>();
  return {
    has(name: string): boolean {
      if (localNames.has(name)) return true;
      const cached = memo.get(name);
      if (cached !== undefined) return cached;
      const result = source.has(name);
      memo.set(name, result);
      return result;
    },
  };
};

/**
 * Build a {@link TypeEnvironment} from a tree-sitter tree for a given language.
 * Single-pass: collects class/struct names, type bindings, AND the unverified
 * constructor bindings — all in one AST walk. When `classNameSource` is provided
 * (Phase 3 path), class names from across the project feed constructor inference;
 * Phase 2 passes only the local AST class names.
 *
 * Returns a no-op env (empty `lookup`, no bindings) when the language has no
 * registered config — `buildTypeEnv` callers also gate on `typeConfigs[language]`.
 */
export const buildTypeEnv = (
  tree: { rootNode: Parser.SyntaxNode },
  language: Language,
  classNameSource?: ClassNameSource,
): TypeEnvironment => {
  const env: TypeEnv = new Map();
  const localClassNames = new Set<string>();
  const classNames = createClassNameLookup(localClassNames, classNameSource);
  const config: LanguageTypeConfig | undefined = typeConfigs[language];
  const bindings: ConstructorBinding[] = [];

  // Unregistered language → no-op env.
  if (!config) {
    return {
      lookup: (varName, callNode) => lookupInEnv(env, varName, callNode),
      constructorBindings: bindings,
      env,
    };
  }

  /**
   * Try to extract a (varName → typeName) binding from a single AST node.
   * Tier 0: explicit annotations via extractDeclaration.
   * Tier 1: constructor-call inference via extractInitializer (fallback).
   */
  const extractTypeBinding = (node: Parser.SyntaxNode, scopeEnv: Map<string, string>): void => {
    // This guard eliminates 90%+ of calls before any language dispatch.
    if (TYPED_PARAMETER_TYPES.has(node.type)) {
      config.extractParameter(node, scopeEnv);
      return;
    }
    if (config.declarationNodeTypes.has(node.type)) {
      config.extractDeclaration(node, scopeEnv);
      // Tier 1: constructor-call inference as fallback. Always called when
      // available — each language's extractInitializer internally skips
      // declarators that already have explicit annotations (handles mixed
      // `const a: A = x, b = new B()`).
      if (config.extractInitializer) {
        config.extractInitializer(node, scopeEnv, classNames);
      }
    }
  };

  const walk = (node: Parser.SyntaxNode, currentScope: string): void => {
    // Collect class/struct names as encountered (lets extractInitializer
    // distinguish constructor calls from function calls in call-syntax langs).
    if (CLASS_CONTAINER_TYPES.has(node.type)) {
      const nameNode = node.childForFieldName("name") ?? findTypeIdentifierChild(node);
      if (nameNode) localClassNames.add(nameNode.text);
    }

    // Detect scope boundaries (function/method definitions).
    let scope = currentScope;
    if (FUNCTION_NODE_TYPES.has(node.type)) {
      const { funcName } = extractFunctionName(node);
      if (funcName) scope = `${funcName}@${node.startIndex}`;
    }

    if (!env.has(scope)) env.set(scope, new Map());
    const scopeEnv = env.get(scope)!;

    extractTypeBinding(node, scopeEnv);

    // Scan for constructor bindings unresolved by the env (verified later).
    if (config.scanConstructorBinding) {
      const result = config.scanConstructorBinding(node);
      if (result && !scopeEnv.has(result.varName)) {
        bindings.push({ scope, ...result });
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child, scope);
    }
  };

  walk(tree.rootNode, FILE_SCOPE);
  return {
    lookup: (varName, callNode) => lookupInEnv(env, varName, callNode),
    constructorBindings: bindings,
    env,
  };
};

export { extractParentClassFromNode };
