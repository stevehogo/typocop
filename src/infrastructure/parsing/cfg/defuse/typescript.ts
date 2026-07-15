/**
 * TypeScript / JavaScript def/use extractor (Plan C — reaching definitions).
 *
 * For each basic block, walks the block's AST nodes to collect simple-variable
 * DEFS (const/let/var declarators, plain-identifier assignment LHS, compound
 * assignments) and USES (identifier reads), excluding declaration names, the LHS
 * identifier of a plain assignment, member-access property names, and object-key
 * names. Field/element flows (o.x, a[i]) are intentionally NOT tracked in the
 * MVP (documented soundness posture). TS and JS share these grammar shapes, so
 * one extractor serves both. Pure: reads the subtree only, never throws.
 */
import type Parser from "tree-sitter";
import type { CfgBlock } from "../cfg-builder.js";
import type { DefUse, DefUseExtractor } from "./types.js";

const DECLARATOR = "variable_declarator";
const ASSIGN = "assignment_expression";
const AUG_ASSIGN = "augmented_assignment_expression"; // some grammar versions
const MEMBER = "member_expression";
const IDENT = "identifier";

/**
 * Collect defs + uses for one block by walking each statement subtree.
 * Uses an explicit stack (no recursion) and a `skip` set of node ids that are
 * declaration/assignment-target/property identifiers (NOT reads).
 */
function collect(nodes: readonly Parser.SyntaxNode[]): DefUse {
  const defs = new Set<string>();
  const uses = new Set<string>();
  // Identifier nodes that are write-targets or non-variable names — never a use.
  const skip = new Set<number>();

  // First pass over each subtree: find defs + mark skip identifiers.
  const markStack: Parser.SyntaxNode[] = [...nodes];
  while (markStack.length > 0) {
    const n = markStack.pop()!;
    if (n.type === DECLARATOR) {
      const nameNode = n.childForFieldName("name");
      if (nameNode && nameNode.type === IDENT) {
        defs.add(nameNode.text);
        skip.add(nameNode.id);
      }
    } else if (n.type === ASSIGN) {
      const left = n.childForFieldName("left");
      if (left && left.type === IDENT) {
        defs.add(left.text);
        skip.add(left.id);
        // Compound assignment (+=, etc.) also READS the LHS.
        const op = n.childForFieldName("operator");
        if (op && op.type !== "=") uses.add(left.text);
      }
    } else if (n.type === AUG_ASSIGN) {
      const left = n.childForFieldName("left");
      if (left && left.type === IDENT) {
        defs.add(left.text);
        uses.add(left.text); // augmented assignment reads then writes
        skip.add(left.id);
      }
    } else if (n.type === MEMBER) {
      // `o.x` reads `o` (the object) but `x` (the property) is NOT a variable use.
      const prop = n.childForFieldName("property");
      if (prop && prop.type === IDENT) skip.add(prop.id);
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c) markStack.push(c);
    }
  }

  // Second pass: every identifier read that wasn't marked skip is a use.
  const useStack: Parser.SyntaxNode[] = [...nodes];
  while (useStack.length > 0) {
    const n = useStack.pop()!;
    if (n.type === IDENT && !skip.has(n.id)) uses.add(n.text);
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c) useStack.push(c);
    }
  }

  return { defs: [...defs], uses: [...uses] };
}

/** Pull simple parameter names from a function/method node's formal_parameters. */
function paramNames(funcNode: Parser.SyntaxNode): string[] {
  const params = funcNode.childForFieldName("parameters")
    ?? firstChildOfType(funcNode, "formal_parameters");
  if (!params) return [];
  const out: string[] = [];
  for (let i = 0; i < params.namedChildCount; i++) {
    const p = params.namedChild(i);
    if (!p) continue;
    // required_parameter / optional_parameter carry a `pattern` field; a bare
    // identifier parameter (JS) is the identifier itself.
    if (p.type === IDENT) {
      out.push(p.text);
      continue;
    }
    const pat = p.childForFieldName("pattern") ?? p.childForFieldName("name");
    if (pat && pat.type === IDENT) out.push(pat.text);
    else if (pat) {
      // destructured / rest pattern: collect leaf identifiers defensively.
      collectLeafIdents(pat, out);
    }
  }
  return out;
}

function collectLeafIdents(node: Parser.SyntaxNode, out: string[]): void {
  const stack = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === IDENT) out.push(n.text);
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
}

function firstChildOfType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && c.type === type) return c;
  }
  return undefined;
}

export const typescriptDefUseExtractor: DefUseExtractor = {
  forBlock(block: CfgBlock): DefUse {
    return collect(block.nodes);
  },
  params(funcNode: Parser.SyntaxNode): readonly string[] {
    return paramNames(funcNode);
  },
};
