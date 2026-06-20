/**
 * Coordinated rename PLAN builder (D5) — PREVIEW-ONLY v1.
 *
 * Builds a diff plan for renaming a symbol from `oldName` to `newName`:
 *   - resolve the symbol (exact → fuzzy, optionally narrowed by file path);
 *   - gather the definition site + every edge-backed reference site
 *     (`CALLS|IMPORTS|REFERENCES` → the resolved target) as HIGH-confidence
 *     edits, each carrying `filePath` + `line`;
 *   - emit a single word-boundary regex DESCRIPTOR for the LOW-confidence text
 *     matches a caller can run itself for the long tail (string keys, comments,
 *     dynamic dispatch the graph can't see).
 *
 * This module is **strictly read-only**: it only ever issues `runCypher`
 * (read) queries. It NEVER calls `runCypherWrite` and NEVER touches the file
 * system. The returned plan always has `preview: true` — v1 produces a diff
 * plan and never mutates anything. Applying the plan is out of scope.
 *
 * Requirements: 15.1, 15.5, 15.6, 15.8, 1.1, 1.2, 1.4, 1.5
 */
import type { GraphAdapter } from "../../core/ports/persistence.js";
import { prop } from "../../core/ports/persistence.js";
import type { CypherNodeRow } from "./graph-helpers.js";
import { rowToNode, graphNodeToSymbol } from "./graph-helpers.js";
import { resolveSymbol, type SymbolResolution } from "./symbol-resolver.js";

/** Confidence band for a planned edit. */
export type EditConfidence = "high" | "low";

/**
 * A single planned, edge-backed edit site. HIGH-confidence: it is anchored to a
 * concrete graph node (the definition) or a node with an edge into the target
 * (a reference). `oldName`/`newName` are carried so a caller can apply the edit
 * without re-deriving them.
 */
export interface RenameEdit {
  readonly filePath: string;
  /** 1-based start line of the symbol/reference occurrence. */
  readonly line: number;
  readonly oldName: string;
  readonly newName: string;
  readonly confidence: EditConfidence;
  /** What anchored this edit: the definition, or the edge type of the reference. */
  readonly kind: "definition" | "reference";
}

/**
 * A descriptor (NOT an applied edit) for the LOW-confidence long tail: a
 * word-boundary regex the caller can run over the tree for occurrences the
 * graph can't anchor (comments, string keys, dynamic dispatch). Returned so the
 * tool stays preview-only — it never runs the regex or edits files itself.
 */
export interface RenameRegexDescriptor {
  /** Source for `new RegExp(pattern, flags)`. */
  readonly pattern: string;
  readonly flags: string;
  readonly oldName: string;
  readonly newName: string;
  readonly confidence: "low";
}

/** The full rename plan. ALWAYS `preview: true` — v1 never mutates. */
export interface RenamePlan {
  readonly resolution: SymbolResolution;
  readonly oldName: string;
  readonly newName: string;
  /** Edge-backed, file:line-anchored edits (definition + references). */
  readonly edits: readonly RenameEdit[];
  /** One word-boundary regex descriptor for the low-confidence text tail. */
  readonly lowConfidence: RenameRegexDescriptor;
  /** INVARIANT: always true in v1. No write path exists. */
  readonly preview: true;
  readonly highConfidenceCount: number;
  /** Always 1 in v1: the single regex descriptor for the text tail. */
  readonly lowConfidenceCount: number;
}

/** Row for the edge-backed reference query: the referencing node + its line. */
interface CypherReferenceRow {
  refId: string;
  filePath: string | null;
  startLine: number | string | null;
}

function toLine(v: number | string | null | undefined): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Escape a string for safe interpolation into a RegExp source. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolve the rename target, optionally narrowing an ambiguous name by file
 * path. When `filePath` is supplied we first try an exact (name AND filePath)
 * match so an ambiguous bare name lands on the intended symbol; otherwise we
 * fall back to the shared {@link resolveSymbol} (exact → fuzzy → not_found).
 */
async function resolveRenameTarget(
  oldName: string,
  graph: GraphAdapter,
  filePath?: string,
): Promise<SymbolResolution> {
  if (filePath) {
    const rows = await graph.runCypher<CypherNodeRow>(
      `MATCH (n:Symbol)
       WHERE (n.id = $val OR n.name = $val) AND n.filePath = $filePath
       RETURN n LIMIT 1`,
      { val: oldName, filePath },
    ) ?? [];
    if (rows.length > 0 && rows[0]?.n?.properties) {
      return { kind: "exact", node: rowToNode(rows[0]) };
    }
    // CONTAINS fallback scoped to the file (handles a partial/ambiguous name).
    const fuzzyRows = await graph.runCypher<CypherNodeRow>(
      `MATCH (n:Symbol)
       WHERE n.name CONTAINS $val AND n.filePath = $filePath
       RETURN n LIMIT 1`,
      { val: oldName, filePath },
    ) ?? [];
    if (fuzzyRows.length > 0 && fuzzyRows[0]?.n?.properties) {
      const node = rowToNode(fuzzyRows[0]);
      return { kind: "fuzzy", node, matchedName: prop(node, "name") };
    }
    // No file-scoped hit → fall through to the global resolver.
  }
  return resolveSymbol(oldName, graph);
}

/**
 * Fetch the edge-backed reference sites of the resolved target: every node with
 * a `CALLS|IMPORTS|REFERENCES` edge INTO the target, with its `filePath` + line.
 * These are HIGH-confidence edits.
 */
async function findReferenceSites(
  graph: GraphAdapter,
  targetId: string,
): Promise<CypherReferenceRow[]> {
  const rows = await graph.runCypher<CypherReferenceRow>(
    `MATCH (r:Symbol)-[:CALLS|IMPORTS|REFERENCES]->(t:Symbol)
     WHERE t.id = $val
     RETURN DISTINCT r.id AS refId, r.filePath AS filePath, r.startLine AS startLine`,
    { val: targetId },
  ) ?? [];
  return rows.filter((row): row is CypherReferenceRow => Boolean(row?.refId));
}

/**
 * Build a coordinated rename plan. PREVIEW-ONLY — read queries only, never a
 * write, never an fs touch. The result always has `preview: true`.
 *
 * @param oldName  current symbol name (or id)
 * @param newName  proposed new name (identifier-shape checked by the tool layer)
 * @param graph    graph adapter (read-only access)
 * @param filePath optional file path to disambiguate an ambiguous name
 */
export async function buildRenamePlan(
  oldName: string,
  newName: string,
  graph: GraphAdapter,
  filePath?: string,
): Promise<RenamePlan> {
  const lowConfidence: RenameRegexDescriptor = {
    pattern: `\\b${escapeRegex(oldName)}\\b`,
    flags: "g",
    oldName,
    newName,
    confidence: "low",
  };

  const resolution = await resolveRenameTarget(oldName, graph, filePath);

  if (resolution.kind === "not_found") {
    return {
      resolution,
      oldName,
      newName,
      edits: [],
      lowConfidence,
      preview: true,
      highConfidenceCount: 0,
      lowConfidenceCount: 1,
    };
  }

  const targetNode = resolution.node;
  const targetSymbol = graphNodeToSymbol(targetNode);

  // The definition site is itself a HIGH-confidence edit.
  const definitionEdit: RenameEdit = {
    filePath: targetSymbol.location.filePath,
    line: targetSymbol.location.startLine,
    oldName,
    newName,
    confidence: "high",
    kind: "definition",
  };

  // Every edge-backed reference into the target is a HIGH-confidence edit.
  const refRows = await findReferenceSites(graph, targetNode.id);
  const referenceEdits: RenameEdit[] = refRows.map((row) => ({
    filePath: row.filePath ?? "",
    line: toLine(row.startLine),
    oldName,
    newName,
    confidence: "high" as const,
    kind: "reference" as const,
  }));

  const edits = [definitionEdit, ...referenceEdits];

  return {
    resolution,
    oldName,
    newName,
    edits,
    lowConfidence,
    preview: true,
    highConfidenceCount: edits.length,
    lowConfidenceCount: 1,
  };
}
