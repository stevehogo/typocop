/**
 * TypeScript / JavaScript control-flow visitor (Plan B).
 *
 * A PURE tree-sitter subtree walk over a function/method/constructor definition
 * node, producing a statement-level intra-procedural CFG: basic blocks + typed
 * control-flow edges (seq/true/false/back). Mirrors complexity.ts's purity —
 * reads the subtree only, never mutates, never throws.
 *
 * TS and JS share the relevant grammar shapes (if_statement, for_statement,
 * for_in_statement, while_statement, do_statement, switch_statement, try_statement,
 * return/break/continue_statement, binary_expression, ternary_expression), so one
 * visitor serves both. Short-circuit (&&/||/??) and ternary are expression-level
 * decisions: the statement block that contains one is tagged `branch`; we do not
 * split an expression into sub-blocks in the MVP.
 *
 * Reference implementation for the overall PDG approach: an open-source CFG/taint
 * indexer (src/core/ingestion/cfg/). No product names per repo convention.
 */
import type Parser from "tree-sitter";
import type { Cfg, CfgBlock, CfgEdge, CfgEdgeKind, CfgVisitor, BlockKind } from "../types.js";

// Statement node types that the walk dispatches on.
const RETURN = "return_statement";
const BREAK = "break_statement";
const CONTINUE = "continue_statement";
const IF = "if_statement";
const FOR = "for_statement";
const FOR_IN = "for_in_statement"; // for…in AND for…of
const WHILE = "while_statement";
const DO = "do_statement";
const SWITCH = "switch_statement";
const TRY = "try_statement";

const SHORT_CIRCUIT_OPS = new Set(["&&", "||", "??"]);

/** Mutable builder state. Blocks/edges accumulate; ids are creation order. */
class CfgWriter {
  readonly blocks: CfgBlock[] = [];
  readonly edges: CfgEdge[] = [];
  private nextId = 0;

  /** Create a block; returns its mutable record so the walk can append nodes. */
  newBlock(kind: BlockKind, line: number): MutBlock {
    const b: MutBlock = { id: this.nextId++, kind, startLine: line, endLine: line, nodes: [] };
    this.blocks.push(b as unknown as CfgBlock);
    return b;
  }
  edge(from: number, to: number, kind: CfgEdgeKind): void {
    this.edges.push({ from, to, kind });
  }
}

interface MutBlock {
  id: number;
  kind: BlockKind;
  startLine: number;
  endLine: number;
  nodes: Parser.SyntaxNode[];
}

interface LoopCtx {
  /** Block the loop condition lives in — `continue` targets it; body-tail back-edges to it. */
  readonly header: number;
  /** Block control reaches after the loop — `break` targets it. */
  readonly join: number;
}

/** True when `node`'s subtree contains a short-circuit `&&/||/??` or a ternary. */
function hasDecisionExpr(node: Parser.SyntaxNode): boolean {
  const stack: Parser.SyntaxNode[] = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === "ternary_expression") return true;
    if (n.type === "binary_expression") {
      const op = n.childForFieldName("operator");
      if (op && SHORT_CIRCUIT_OPS.has(op.type)) return true;
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
  return false;
}

/** The `statement_block` body of a definition node, or the node itself if none. */
function bodyOf(funcNode: Parser.SyntaxNode): Parser.SyntaxNode {
  const body = funcNode.childForFieldName("body");
  if (body && body.type === "statement_block") return body;
  for (let i = 0; i < funcNode.namedChildCount; i++) {
    const c = funcNode.namedChild(i);
    if (c && c.type === "statement_block") return c;
  }
  return funcNode;
}

/** 1-based start line of a node. */
const lineOf = (n: Parser.SyntaxNode): number => n.startPosition.row + 1;

class TsCfgBuilder {
  private readonly w = new CfgWriter();
  private readonly loops: LoopCtx[] = [];
  private readonly exit: MutBlock;
  private readonly entry: MutBlock;

  constructor(private readonly funcNode: Parser.SyntaxNode) {
    this.entry = this.w.newBlock("entry", lineOf(funcNode));
    this.exit = this.w.newBlock("exit", lineOf(funcNode)); // id 1; remains the exit
  }

  build(): Cfg {
    const body = bodyOf(this.funcNode);
    const first = this.w.newBlock("normal", lineOf(body));
    this.w.edge(this.entry.id, first.id, "seq");
    const tail = this.walkStatements(body, first);
    if (tail !== null) this.w.edge(tail.id, this.exit.id, "seq");
    return { blocks: this.w.blocks, edges: this.w.edges, entry: this.entry.id, exit: this.exit.id };
  }

  /**
   * Walk a block's direct named statements, threading `current`. Returns the
   * open block reached at the end (to wire onward), or `null` if control left
   * via return/break/continue (no fall-through tail).
   */
  private walkStatements(block: Parser.SyntaxNode, start: MutBlock): MutBlock | null {
    let current: MutBlock | null = start;
    for (let i = 0; i < block.namedChildCount; i++) {
      const stmt = block.namedChild(i);
      if (!stmt) continue;
      if (current === null) current = this.w.newBlock("normal", lineOf(stmt)); // unreachable tail
      current = this.handle(stmt, current);
    }
    return current;
  }

  /** Process one statement; return the open tail block, or null if control left. */
  private handle(stmt: Parser.SyntaxNode, current: MutBlock): MutBlock | null {
    switch (stmt.type) {
      case RETURN:
        this.appendTo(current, stmt);
        this.w.edge(current.id, this.exit.id, "seq");
        return null;
      case BREAK: {
        this.appendTo(current, stmt);
        const ctx = this.loops[this.loops.length - 1];
        if (ctx) this.w.edge(current.id, ctx.join, "seq");
        return null;
      }
      case CONTINUE: {
        this.appendTo(current, stmt);
        const ctx = this.loops[this.loops.length - 1];
        if (ctx) this.w.edge(current.id, ctx.header, "back");
        return null;
      }
      case IF:
        return this.handleIf(stmt, current);
      case FOR:
      case FOR_IN:
      case WHILE:
        return this.handleHeaderLoop(stmt, current);
      case DO:
        return this.handleDoWhile(stmt, current);
      case SWITCH:
        return this.handleSwitch(stmt, current);
      case TRY:
        return this.handleTry(stmt, current);
      default:
        this.appendTo(current, stmt);
        return current;
    }
  }

  /** Append a plain statement; extend the block span + decision tag. */
  private appendTo(block: MutBlock, stmt: Parser.SyntaxNode): void {
    block.nodes.push(stmt);
    block.endLine = Math.max(block.endLine, stmt.endPosition.row + 1);
    if (block.kind === "normal" && hasDecisionExpr(stmt)) block.kind = "branch";
  }

  private handleIf(stmt: Parser.SyntaxNode, current: MutBlock): MutBlock | null {
    // `current` becomes the branch header (carries the if's condition statement).
    current.kind = "branch";
    current.nodes.push(stmt);
    current.endLine = Math.max(current.endLine, lineOf(stmt));
    const join = this.w.newBlock("normal", lineOf(stmt));

    const consequence = stmt.childForFieldName("consequence");
    const thenB = this.w.newBlock("normal", consequence ? lineOf(consequence) : lineOf(stmt));
    this.w.edge(current.id, thenB.id, "true");
    const thenTail = consequence ? this.walkStatements(consequence, thenB) : thenB;
    if (thenTail !== null) this.w.edge(thenTail.id, join.id, "seq");

    const alt = stmt.childForFieldName("alternative"); // else_clause | undefined
    if (alt) {
      const inner = alt.namedChild(0); // statement_block OR nested if_statement
      const elseB = this.w.newBlock("normal", lineOf(alt));
      this.w.edge(current.id, elseB.id, "false");
      let elseTail: MutBlock | null = elseB;
      if (inner && inner.type === "statement_block") elseTail = this.walkStatements(inner, elseB);
      else if (inner) elseTail = this.handle(inner, elseB); // else-if
      if (elseTail !== null) this.w.edge(elseTail.id, join.id, "seq");
    } else {
      this.w.edge(current.id, join.id, "false");
    }
    return join;
  }

  /** for / for-in / for-of / while: header with a body that back-edges to it. */
  private handleHeaderLoop(stmt: Parser.SyntaxNode, current: MutBlock): MutBlock {
    current.kind = "loop";
    current.nodes.push(stmt);
    current.endLine = Math.max(current.endLine, lineOf(stmt));
    const join = this.w.newBlock("normal", lineOf(stmt));
    const bodyNode = stmt.childForFieldName("body") ?? lastStatementBlock(stmt);
    const bodyB = this.w.newBlock("normal", bodyNode ? lineOf(bodyNode) : lineOf(stmt));
    this.w.edge(current.id, bodyB.id, "true");
    this.w.edge(current.id, join.id, "false");
    this.loops.push({ header: current.id, join: join.id });
    const tail = bodyNode && bodyNode.type === "statement_block"
      ? this.walkStatements(bodyNode, bodyB)
      : bodyB;
    this.loops.pop();
    if (tail !== null) this.w.edge(tail.id, current.id, "back");
    return join;
  }

  /** do { body } while (cond): body runs first; cond back-edges to body. */
  private handleDoWhile(stmt: Parser.SyntaxNode, current: MutBlock): MutBlock {
    // `current` is the do-body entry (top of the loop).
    current.nodes.push(stmt);
    current.endLine = Math.max(current.endLine, lineOf(stmt));
    const join = this.w.newBlock("normal", lineOf(stmt));
    const cond = this.w.newBlock("loop", lineOf(stmt));
    const bodyNode = stmt.childForFieldName("body") ?? lastStatementBlock(stmt);
    this.loops.push({ header: cond.id, join: join.id });
    const tail = bodyNode && bodyNode.type === "statement_block"
      ? this.walkStatements(bodyNode, current)
      : current;
    this.loops.pop();
    if (tail !== null) this.w.edge(tail.id, cond.id, "seq");
    this.w.edge(cond.id, current.id, "back"); // loop again
    this.w.edge(cond.id, join.id, "false");   // exit
    return join;
  }

  private handleSwitch(stmt: Parser.SyntaxNode, current: MutBlock): MutBlock {
    current.kind = "switch";
    current.nodes.push(stmt);
    current.endLine = Math.max(current.endLine, lineOf(stmt));
    const join = this.w.newBlock("normal", lineOf(stmt));
    const switchBody = stmt.childForFieldName("body")
      ?? firstChildOfType(stmt, "switch_body");
    let hasDefault = false;
    if (switchBody) {
      for (let i = 0; i < switchBody.namedChildCount; i++) {
        const c = switchBody.namedChild(i);
        if (!c) continue;
        if (c.type === "switch_case" || c.type === "switch_default") {
          if (c.type === "switch_default") hasDefault = true;
          const caseB = this.w.newBlock("normal", lineOf(c));
          this.w.edge(current.id, caseB.id, "true");
          const tail = this.walkStatements(c, caseB);
          if (tail !== null) this.w.edge(tail.id, join.id, "seq");
        }
      }
    }
    if (!hasDefault) this.w.edge(current.id, join.id, "false"); // a path skips all cases
    return join;
  }

  private handleTry(stmt: Parser.SyntaxNode, current: MutBlock): MutBlock | null {
    const join = this.w.newBlock("normal", lineOf(stmt));
    const tryBlockNode = stmt.childForFieldName("body") ?? firstChildOfType(stmt, "statement_block");
    const tryB = this.w.newBlock("normal", tryBlockNode ? lineOf(tryBlockNode) : lineOf(stmt));
    this.w.edge(current.id, tryB.id, "seq");
    const tryTail = tryBlockNode ? this.walkStatements(tryBlockNode, tryB) : tryB;

    const catchNode = firstChildOfType(stmt, "catch_clause");
    const finallyNode = firstChildOfType(stmt, "finally_clause");
    let catchTail: MutBlock | null = null;
    if (catchNode) {
      const catchB = this.w.newBlock("catch", lineOf(catchNode));
      this.w.edge(tryB.id, catchB.id, "true"); // exceptional edge
      const catchBody = firstChildOfType(catchNode, "statement_block");
      catchTail = catchBody ? this.walkStatements(catchBody, catchB) : catchB;
    }

    if (finallyNode) {
      const finallyBody = firstChildOfType(finallyNode, "statement_block");
      const finallyB = this.w.newBlock("normal", lineOf(finallyNode));
      if (tryTail !== null) this.w.edge(tryTail.id, finallyB.id, "seq");
      if (catchTail !== null) this.w.edge(catchTail.id, finallyB.id, "seq");
      const fTail = finallyBody ? this.walkStatements(finallyBody, finallyB) : finallyB;
      if (fTail !== null) this.w.edge(fTail.id, join.id, "seq");
    } else {
      if (tryTail !== null) this.w.edge(tryTail.id, join.id, "seq");
      if (catchTail !== null) this.w.edge(catchTail.id, join.id, "seq");
    }
    return join;
  }
}

function firstChildOfType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && c.type === type) return c;
  }
  return undefined;
}

function lastStatementBlock(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  let found: Parser.SyntaxNode | undefined;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && c.type === "statement_block") found = c;
  }
  return found;
}

export const typescriptCfgVisitor: CfgVisitor = {
  build(funcNode: Parser.SyntaxNode): Cfg {
    return new TsCfgBuilder(funcNode).build();
  },
};
