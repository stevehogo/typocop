/**
 * Per-language type-extraction config interfaces (Wave 3, Tier B).
 *
 * Ported from the legacy parser (typocop's pre-refactor parser lineage), re-keyed
 * to typocop's raw tree-sitter `Parser.SyntaxNode` (NOT the eager `ASTNode`
 * wrapper — these need `childForFieldName`/`namedChild`). Dependency-free of
 * `core/domain.ts`.
 */
import type Parser from "tree-sitter";

/** Extracts type bindings from a declaration node into the env map. */
export type TypeBindingExtractor = (
  node: Parser.SyntaxNode,
  env: Map<string, string>,
) => void;

/** Extracts type bindings from a parameter node into the env map. */
export type ParameterExtractor = (
  node: Parser.SyntaxNode,
  env: Map<string, string>,
) => void;

/**
 * Minimal interface for checking whether a name is a known class/struct.
 * Narrower than `ReadonlySet` — only `.has()` is used by extractors.
 */
export type ClassNameLookup = { has(name: string): boolean };

/**
 * Extracts type bindings from a constructor-call initializer, with access to
 * known class names (so call-syntax constructors can be class-verified).
 */
export type InitializerExtractor = (
  node: Parser.SyntaxNode,
  env: Map<string, string>,
  classNames: ClassNameLookup,
) => void;

/**
 * Scans an AST node for untyped `var = callee()` patterns for return-type
 * inference. Returns `{ varName, calleeName }` if the node matches, else
 * `undefined`. `receiverClassName` — optional hint for method calls on known
 * receivers (e.g. `$this->getUser()` in PHP provides the enclosing class name).
 */
export type ConstructorBindingScanner = (
  node: Parser.SyntaxNode,
) => { varName: string; calleeName: string; receiverClassName?: string } | undefined;

/**
 * Extracts a return-type string from a method/function definition node. Used for
 * languages where return types are expressed in comments (e.g. JSDoc/PHPDoc)
 * rather than in AST fields. Returns `undefined` if none can be determined.
 */
export type ReturnTypeExtractor = (node: Parser.SyntaxNode) => string | undefined;

/** Per-language type-extraction configuration. */
export interface LanguageTypeConfig {
  /** Node types that represent typed declarations for this language. */
  readonly declarationNodeTypes: ReadonlySet<string>;
  /** Extract a (varName → typeName) binding from a declaration node. */
  readonly extractDeclaration: TypeBindingExtractor;
  /** Extract a (varName → typeName) binding from a parameter node. */
  readonly extractParameter: ParameterExtractor;
  /**
   * Extract a (varName → typeName) binding from a constructor-call initializer.
   * Called as fallback when `extractDeclaration` produces no binding. Only for
   * languages with syntactic constructor markers (`new`, composite literal,
   * `::new`). Receives `classNames` — the class/struct names visible in the
   * current file's AST (plus, when supplied, the cross-file SymbolTable).
   */
  readonly extractInitializer?: InitializerExtractor;
  /**
   * Scan for untyped `var = callee()` assignments for return-type inference.
   * Called on every AST node during `buildTypeEnv`; returns `undefined` for
   * non-matches. The callee binding is UNVERIFIED — the caller must confirm
   * against the SymbolTable.
   */
  readonly scanConstructorBinding?: ConstructorBindingScanner;
  /**
   * Extract return type from comment-based annotations (JSDoc/PHPDoc). Called as
   * fallback when AST-based return-type extraction finds nothing.
   */
  readonly extractReturnType?: ReturnTypeExtractor;
}
