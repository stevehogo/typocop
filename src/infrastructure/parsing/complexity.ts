/**
 * Complexity metrics (E2).
 *
 * A PURE tree-sitter subtree walk over a definition node (function / method /
 * constructor) that derives three classic complexity numbers:
 *
 *   - `cyclomatic`  — `1 + (# decision nodes)`. Decision nodes are the branch
 *                     points: `if` / `for` / `while` / `case` / `catch`,
 *                     short-circuit boolean operators (`&&`, `||`, `??`), and
 *                     the ternary/conditional expression.
 *   - `cognitive`   — a nesting-weighted variant: every decision node adds
 *                     `1 + currentNestingDepth`, so deeply nested branches cost
 *                     more than flat ones (Campbell's cognitive complexity, a
 *                     simplified take: nesting increments only on structural
 *                     branch/loop constructs).
 *   - `maxLoopDepth`— the deepest run of nested loop constructs.
 *
 * Language coverage: TS/JS/Python/Java/Go ship full decision-node sets. Every
 * other language degrades gracefully to **cyclomatic-only** (cognitive ==
 * cyclomatic-style count, maxLoopDepth == 0) using a conservative shared set —
 * never throwing, never reaching into a grammar it does not understand.
 *
 * This lives in the parsing layer (infrastructure) because it needs the live
 * `Parser.SyntaxNode` tree, which only exists during extraction.
 */
import type Parser from "tree-sitter";
import type { ComplexityMetrics, Language } from "../../core/domain.js";

export type { ComplexityMetrics };

/**
 * Per-language node-type classification. `decision` types add a cyclomatic
 * branch; the subset in `loop` also deepens loop/nesting depth. `nesting` types
 * raise the cognitive nesting level without themselves being a decision (none
 * needed today — loops/branches already cover it). Boolean short-circuit
 * operators are handled separately because they are an operator on a
 * `binary_expression`, not a distinct node type, in most grammars.
 */
interface LangSpec {
  /** Node types that count as a decision (cyclomatic +1). */
  readonly decision: ReadonlySet<string>;
  /** Decision node types that are loops (drive maxLoopDepth + nesting). */
  readonly loop: ReadonlySet<string>;
  /** `binary_expression`-style node type whose `&&`/`||`/`??` operators count. */
  readonly binaryExpr: ReadonlySet<string>;
  /** Short-circuit operator texts that count as a decision. */
  readonly shortCircuitOps: ReadonlySet<string>;
  /** Dedicated boolean-operator node type (Python), counted directly. */
  readonly booleanOp: ReadonlySet<string>;
}

const TS_JS: LangSpec = {
  decision: new Set([
    "if_statement",
    "for_statement",
    "for_in_statement",
    "while_statement",
    "do_statement",
    "switch_case",
    "catch_clause",
    "ternary_expression",
  ]),
  loop: new Set(["for_statement", "for_in_statement", "while_statement", "do_statement"]),
  binaryExpr: new Set(["binary_expression"]),
  shortCircuitOps: new Set(["&&", "||", "??"]),
  booleanOp: new Set(),
};

const PYTHON: LangSpec = {
  decision: new Set([
    "if_statement",
    "elif_clause",
    "for_statement",
    "while_statement",
    "except_clause",
    "conditional_expression",
  ]),
  loop: new Set(["for_statement", "while_statement"]),
  binaryExpr: new Set(),
  shortCircuitOps: new Set(),
  // Python models `a and b` / `a or b` as a `boolean_operator` node.
  booleanOp: new Set(["boolean_operator"]),
};

const JAVA: LangSpec = {
  decision: new Set([
    "if_statement",
    "for_statement",
    "enhanced_for_statement",
    "while_statement",
    "do_statement",
    "switch_label",
    "catch_clause",
    "ternary_expression",
  ]),
  loop: new Set(["for_statement", "enhanced_for_statement", "while_statement", "do_statement"]),
  binaryExpr: new Set(["binary_expression"]),
  shortCircuitOps: new Set(["&&", "||"]),
  booleanOp: new Set(),
};

const GO: LangSpec = {
  decision: new Set([
    "if_statement",
    "for_statement",
    "expression_case",
    "type_case",
    "communication_case",
  ]),
  loop: new Set(["for_statement"]),
  binaryExpr: new Set(["binary_expression"]),
  shortCircuitOps: new Set(["&&", "||"]),
  booleanOp: new Set(),
};

/**
 * Conservative fallback used for languages without a dedicated spec. Counts the
 * branch/loop constructs whose node-type names are near-universal across
 * tree-sitter grammars, so other languages still get a useful cyclomatic-only
 * number without claiming cognitive/loop-depth fidelity.
 */
const FALLBACK: LangSpec = {
  decision: new Set([
    "if_statement",
    "for_statement",
    "while_statement",
    "do_statement",
    "catch_clause",
    "switch_case",
    "switch_label",
    "case_statement",
    "when_clause",
    "rescue",
    "conditional_expression",
    "ternary_expression",
    // `_expression`-form control flow (Rust and similar grammars).
    "if_expression",
    "for_expression",
    "while_expression",
    "loop_expression",
    "match_arm",
  ]),
  loop: new Set([
    "for_statement", "while_statement", "do_statement",
    "for_expression", "while_expression", "loop_expression",
  ]),
  binaryExpr: new Set(),
  shortCircuitOps: new Set(),
  booleanOp: new Set(),
};

const FULL_SUPPORT: ReadonlySet<Language> = new Set<Language>([
  "typescript",
  "javascript",
  "python",
  "java",
  "go",
]);

function specFor(language: Language): { spec: LangSpec; full: boolean } {
  switch (language) {
    case "typescript":
    case "javascript":
      return { spec: TS_JS, full: true };
    case "python":
      return { spec: PYTHON, full: true };
    case "java":
      return { spec: JAVA, full: true };
    case "go":
      return { spec: GO, full: true };
    default:
      return { spec: FALLBACK, full: false };
  }
}

/** The operator text of a binary/short-circuit node, or "" if none. */
function operatorText(node: Parser.SyntaxNode): string {
  const op = node.childForFieldName("operator");
  return op ? op.type : "";
}

/**
 * Compute complexity metrics for a single function/method/constructor
 * definition node. Pure: reads the subtree only, never mutates, never throws.
 *
 * @param defNode  the definition node (e.g. `function_declaration`)
 * @param language the source language (drives the decision-node set)
 */
export function computeComplexity(
  defNode: Parser.SyntaxNode,
  language: Language,
): ComplexityMetrics {
  const { spec } = specFor(language);

  let cyclomatic = 1; // base path
  let cognitive = 0;
  let maxLoopDepth = 0;

  // Iterative DFS carrying the current cognitive nesting level and loop depth so
  // the walk stays O(nodes) and avoids deep recursion on large functions.
  const stack: Array<{ node: Parser.SyntaxNode; nesting: number; loopDepth: number }> = [
    { node: defNode, nesting: 0, loopDepth: 0 },
  ];

  while (stack.length > 0) {
    const { node, nesting, loopDepth } = stack.pop()!;

    let childNesting = nesting;
    let childLoopDepth = loopDepth;

    const type = node.type;
    const isDecision = spec.decision.has(type);
    const isBoolean = spec.booleanOp.has(type);
    const isBinaryShort =
      spec.binaryExpr.has(type) && spec.shortCircuitOps.has(operatorText(node));

    if (node !== defNode && (isDecision || isBoolean || isBinaryShort)) {
      cyclomatic += 1;
      // Cognitive: each branch costs 1 + the depth it is nested at. Boolean
      // short-circuits add a flat +1 (operator sequences), matching the
      // cognitive-complexity convention.
      cognitive += isDecision ? 1 + nesting : 1;

      if (isDecision) childNesting = nesting + 1;

      if (spec.loop.has(type)) {
        childLoopDepth = loopDepth + 1;
        if (childLoopDepth > maxLoopDepth) maxLoopDepth = childLoopDepth;
      }
    }

    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push({ node: child, nesting: childNesting, loopDepth: childLoopDepth });
    }
  }

  return { cyclomatic, cognitive, maxLoopDepth };
}

/** True when `language` ships a full (cognitive + loop-depth) decision set. */
export function hasFullComplexitySupport(language: Language): boolean {
  return FULL_SUPPORT.has(language);
}
