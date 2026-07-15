/**
 * Self-shadowing recursion detection (pure, two signals).
 *
 * Flags a method whose body calls itself via an UNQUALIFIED `this`/`self`
 * receiver naming its own method, when EITHER:
 *   A. shadows-super  — the caller has a concrete `overrides` super of that name
 *                       (the call most likely meant `super`/`parent::`); or
 *   B. arity-mismatch — the self-call passes MORE args than the method declares
 *                       (it cannot be this method — it shadows a magic accessor,
 *                       a global fn, etc.).
 * HIGH PRECISION: same-arity self-recursion with no override is legitimate and
 * NOT flagged. Variadic methods (parameterCount undefined) are excluded from B.
 *
 * Pure: consumes resolved symbols, `call` hints, and Phase-3 relationships
 * (for `overrides` edges). No DB, no tree.
 */
import type { Symbol, SymbolKind, Relationship, Language } from "../../../core/domain.js";
import type { RawRelationshipHint } from "../../../infrastructure/parsing/extract-symbols.js";

export type RecursionSuspectKind = "shadows-super" | "arity-mismatch" | "no-progress";

// The kinds a self-call's enclosing caller can be. Used to exclude the enclosing
// CLASS, whose range covers the same line(s) as its single-line methods (a naive
// line-range lookup would otherwise resolve the call to the class, not the method).
const CALLABLE_KINDS = new Set<SymbolKind>(["function", "method"]);

/**
 * Narrowest enclosing CALLABLE symbol containing `line` — the line-range fallback
 * used only when a hint carries no `enclosingSymbolId` (synthetic/unit hints).
 * Real parser hints carry `enclosingSymbolId` (the parser's enclosing-def answer),
 * which is preferred and resolves the caller without any range ambiguity.
 */
function enclosingCallable(fileSyms: readonly Symbol[] | undefined, line: number): Symbol | undefined {
  if (!fileSyms) return undefined;
  let best: Symbol | undefined;
  for (const s of fileSyms) {
    if (!CALLABLE_KINDS.has(s.kind)) continue;
    if (s.location.startLine > line || s.location.endLine < line) continue;
    if (!best || s.location.endLine - s.location.startLine < best.location.endLine - best.location.startLine) {
      best = s; // keep the narrowest enclosing callable
    }
  }
  return best;
}

export interface RecursionSuspect {
  readonly callerId: string;
  readonly callLine: number;
  readonly receiver: string;
  readonly language: Language;
  readonly kind: RecursionSuspectKind;
  readonly callText?: string;
}

const SELF_RECEIVERS = new Set(["this", "self"]); // matches resolver isSelf (index.ts:701)

/**
 * Normalise a raw receiver to the `this`/`self` token the resolver compares
 * against. The parser captures receiver text verbatim (`extractReceiverText`
 * does NOT strip the sigil), so PHP yields `$this`; drop a leading `$` so PHP
 * self-calls are recognised like every other language's `this`/`self`.
 */
function normaliseReceiver(raw: string): string {
  return raw.startsWith("$") ? raw.slice(1) : raw;
}

export function detectRecursionSuspects(
  symbols: readonly Symbol[],
  hints: readonly RawRelationshipHint[],
  relationships: readonly Relationship[],
): RecursionSuspect[] {
  const overridingSources = new Set<string>(); // caller ids with a concrete `overrides` super
  for (const rel of relationships) {
    if (rel.relType === "overrides") overridingSources.add(rel.source);
  }

  const byId = new Map<string, Symbol>();
  const symbolsByFile = new Map<string, Symbol[]>();
  for (const s of symbols) {
    byId.set(s.id, s);
    const list = symbolsByFile.get(s.location.filePath);
    if (list) list.push(s);
    else symbolsByFile.set(s.location.filePath, [s]);
  }

  const byCaller = new Map<string, RecursionSuspect>();
  const fileById = new Map<string, string>();
  for (const hint of hints) {
    if (hint.kind !== "call") continue;
    const rawReceiver = hint.receiverText?.trim();
    if (!rawReceiver) continue;
    const receiver = normaliseReceiver(rawReceiver);
    if (!SELF_RECEIVERS.has(receiver)) continue;

    // Prefer the parser's enclosing-def answer; fall back to the narrowest
    // enclosing callable on the line (synthetic hints carry no enclosingSymbolId).
    const caller =
      (hint.enclosingSymbolId ? byId.get(hint.enclosingSymbolId) : undefined) ??
      enclosingCallable(symbolsByFile.get(hint.sourceFile), hint.startLine);
    if (!caller) continue;
    if (hint.targetName !== caller.name) continue;     // self-NAMED call
    if (byCaller.has(caller.id)) continue;             // one finding per caller

    // Signal A (preferred): a concrete overrides super of this name exists.
    let kind: RecursionSuspectKind | undefined;
    if (overridingSources.has(caller.id)) {
      kind = "shadows-super";
    } else if (
      // Signal B: self-call passes more args than the method declares. Variadics
      // (parameterCount undefined) are excluded.
      caller.parameterCount !== undefined && hint.argCount !== undefined && hint.argCount > caller.parameterCount
    ) {
      kind = "arity-mismatch";
    } else if (hint.selfCallNoProgress === true) {
      // Signal C: the self-call re-passes the method's parameters unchanged (no
      // argument progress) — infinite recursion no override/arity signal can see.
      // Needs no indexed parent, so it catches framework overrides whose super
      // lives in an un-scanned vendor/.
      kind = "no-progress";
    }
    if (!kind) continue;

    byCaller.set(caller.id, {
      callerId: caller.id, callLine: hint.startLine, receiver, language: hint.language, kind,
      ...(hint.callText ? { callText: hint.callText } : {}),
    });
    fileById.set(caller.id, caller.location.filePath);
  }

  return [...byCaller.values()].sort((a, b) => {
    const fa = fileById.get(a.callerId) ?? "";
    const fb = fileById.get(b.callerId) ?? "";
    return fa === fb ? a.callLine - b.callLine : fa < fb ? -1 : 1;
  });
}
