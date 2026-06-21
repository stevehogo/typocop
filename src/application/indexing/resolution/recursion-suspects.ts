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
import type { Symbol, Relationship, Language } from "../../../core/domain.js";
import type { RawRelationshipHint } from "../../../infrastructure/parsing/extract-symbols.js";

export type RecursionSuspectKind = "shadows-super" | "arity-mismatch";

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

  const symbolsByFile = new Map<string, Symbol[]>();
  for (const s of symbols) {
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

    const fileSyms = symbolsByFile.get(hint.sourceFile);
    if (!fileSyms) continue;
    const caller = fileSyms.find(
      (s) => s.location.startLine <= hint.startLine && s.location.endLine >= hint.startLine,
    );
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
