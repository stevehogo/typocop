import type { SyntaxNode } from "tree-sitter";

/**
 * ASTNode wraps a tree-sitter SyntaxNode with a plain-object interface
 * so the rest of the system doesn't depend directly on tree-sitter types.
 */
export interface ASTNode {
  readonly type: string;
  readonly text: string;
  readonly startPosition: { readonly row: number; readonly column: number };
  readonly endPosition: { readonly row: number; readonly column: number };
  readonly children: ASTNode[];
  readonly parent: ASTNode | null;
}

/** Convert a tree-sitter SyntaxNode into our ASTNode (eagerly, no parent cycle) */
export function fromSyntaxNode(node: SyntaxNode, parent: ASTNode | null = null): ASTNode {
  const astNode: ASTNode = {
    type: node.type,
    text: node.text,
    startPosition: { row: node.startPosition.row, column: node.startPosition.column },
    endPosition: { row: node.endPosition.row, column: node.endPosition.column },
    children: [],
    parent,
  };

  // Populate children after creating the node so parent reference is stable
  (astNode as { children: ASTNode[] }).children = node.children.map(
    (child) => fromSyntaxNode(child, astNode)
  );

  return astNode;
}
