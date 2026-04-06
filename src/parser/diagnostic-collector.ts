import type { SyntaxNode } from "tree-sitter";

export interface Diagnostic {
  readonly filePath: string;
  readonly line: number;    // 1-based
  readonly col: number;     // 0-based
  readonly message: string;
  readonly snippet?: string; // undefined when source is empty or line out of range
}

/**
 * Extract a snippet centred on errorRow (0-based), with up to 1 line of context
 * above and below, clamped to file bounds. Returns undefined when source is empty
 * or errorRow is out of range.
 */
function extractSnippet(source: string, errorRow: number, col: number): string | undefined {
  if (source.length === 0) return undefined;

  const lines = source.split("\n");
  if (errorRow >= lines.length) return undefined;

  const contextStart = Math.max(0, errorRow - 1);
  const contextEnd = Math.min(lines.length - 1, errorRow + 1);
  const contextLines = lines.slice(contextStart, contextEnd + 1);

  return contextLines.join("\n") + "\n" + " ".repeat(col) + "^";
}

/** Classify an Error_Node into a human-readable message. */
function nodeMessage(node: SyntaxNode): string {
  return `Missing token: ${node.type}`;
}

/** Depth-first walk; yields only missing-token nodes (isMissing). */
function* walkErrorNodes(node: SyntaxNode): Generator<SyntaxNode> {
  if (node.isMissing) {
    yield node;
  }
  for (const child of node.children) {
    yield* walkErrorNodes(child);
  }
}

/**
 * Walk the AST rooted at `rootNode`, collect all Error_Nodes, and return one
 * Diagnostic per node. Falls back to a single "Unknown syntax error" diagnostic
 * at line 1, col 0 when no Error_Nodes are found.
 */
export function collectDiagnostics(
  rootNode: SyntaxNode,
  source: string,
  filePath: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const node of walkErrorNodes(rootNode)) {
    const row = node.startPosition.row;
    const col = node.startPosition.column;
    const snippet = extractSnippet(source, row, col);

    const diagnostic: Diagnostic = {
      filePath,
      line: row + 1,
      col,
      message: nodeMessage(node),
      ...(snippet !== undefined ? { snippet } : {}),
    };

    diagnostics.push(diagnostic);
  }

  if (diagnostics.length === 0) {
    const snippet = extractSnippet(source, 0, 0);
    const fallback: Diagnostic = {
      filePath,
      line: 1,
      col: 0,
      message: "Unknown syntax error",
      ...(snippet !== undefined ? { snippet } : {}),
    };
    return [fallback];
  }

  return diagnostics;
}
