/**
 * Wave 3 (Tier B) Task 6/7 — Phase 3 consumes `hint.receiverType`.
 *
 * `resolveHints` with a `call` hint carrying `receiverType: 'User'` resolves
 * `u.save()` → `User.save` (the keystone). Flag OFF → that resolution path is
 * skipped and the output is identical to a run with NO `receiverType` field
 * (golden additivity).
 */
import { describe, expect, it } from "vitest";
import type { Symbol } from "../../../core/domain.js";
import type { RawRelationshipHint } from "../parsing/index.js";
import { resolveHints } from "./index.js";

const FILE = "/repo/src/app.ts";

function sym(partial: Partial<Symbol> & Pick<Symbol, "id" | "name" | "kind">): Symbol {
  return {
    logicalKey: partial.id,
    location: { filePath: FILE, startLine: partial.location?.startLine ?? 1, startColumn: 0, endLine: partial.location?.endLine ?? 1, endColumn: 0 },
    visibility: "public",
    modifiers: [],
    ...partial,
  } as Symbol;
}

/**
 * Two classes each declaring `save`; the caller `run` invokes `u.save()` on a
 * `User`. With `receiverType: 'User'`, resolution must target User.save, NOT
 * the decoy Order.save.
 */
function fixture(): { symbols: Symbol[]; userSave: Symbol; orderSave: Symbol; run: Symbol } {
  const user = sym({ id: "id:User", name: "User", kind: "class", location: { filePath: FILE, startLine: 1, startColumn: 0, endLine: 3, endColumn: 0 } });
  const order = sym({ id: "id:Order", name: "Order", kind: "class", location: { filePath: FILE, startLine: 5, startColumn: 0, endLine: 7, endColumn: 0 } });
  const userSave = sym({ id: "id:User.save", name: "save", kind: "method", ownerId: "id:User", location: { filePath: FILE, startLine: 2, startColumn: 2, endLine: 2, endColumn: 20 } });
  const orderSave = sym({ id: "id:Order.save", name: "save", kind: "method", ownerId: "id:Order", location: { filePath: FILE, startLine: 6, startColumn: 2, endLine: 6, endColumn: 20 } });
  const run = sym({ id: "id:run", name: "run", kind: "function", location: { filePath: FILE, startLine: 10, startColumn: 0, endLine: 13, endColumn: 0 } });
  return { symbols: [user, order, userSave, orderSave, run], userSave, orderSave, run };
}

function callHint(extra: Partial<RawRelationshipHint> = {}): RawRelationshipHint {
  return {
    kind: "call",
    sourceFile: FILE,
    targetName: "save",
    startLine: 11,
    language: "typescript",
    receiverText: "u",
    ...extra,
  };
}

describe("resolveHints — receiverType-first member-call resolution (Tier B)", () => {
  it("flag ON + receiverType:'User' → calls edge targets User.save", () => {
    const { symbols, userSave, run } = fixture();
    const hints = [callHint({ receiverType: "User" })];
    const { relationships } = resolveHints(hints, symbols, undefined, undefined, true);
    const call = relationships.find((r) => r.relType === "calls" && r.source === run.id);
    expect(call?.target).toBe(userSave.id);
  });

  it("flag OFF → receiverType ignored; output identical to no-receiverType hint", () => {
    const { symbols } = fixture();
    const withType = resolveHints([callHint({ receiverType: "User" })], symbols, undefined, undefined, false);
    const without = resolveHints([callHint()], symbols, undefined, undefined, false);
    // Both must produce the byte-identical relationship set (golden additivity).
    expect(withType.relationships).toEqual(without.relationships);
  });

  it("flag ON but receiverType resolves to no class → falls through to parity", () => {
    const { symbols } = fixture();
    // 'Ghost' names no class symbol → the receiverType branch must not emit an edge from it.
    const onGhost = resolveHints([callHint({ receiverType: "Ghost", receiverText: "u" })], symbols, undefined, undefined, true);
    // Same hint without receiverType, flag on — must match (the Ghost type adds nothing).
    const onNone = resolveHints([callHint({ receiverText: "u" })], symbols, undefined, undefined, true);
    expect(onGhost.relationships).toEqual(onNone.relationships);
  });

  it("Tier A1 precedence: a compiler-API receiverType drives the SAME Phase-3 path", () => {
    // Phase 3 is tier-agnostic: it consumes `hint.receiverType` regardless of
    // which producer (Tier A1 compiler API or Tier B AST env) set it. Here the
    // value `User` is the one the Tier-A1 enrichment pass would have STAMPED
    // (overriding any Tier-B guess) for the cross-file `a.save()` keystone — and
    // it resolves to User.save, never the decoy Order.save. This is the Phase-3
    // half of the A1 end-to-end (the production half is covered in
    // infrastructure/parsing/ts-types/ts-compiler.test.ts).
    const { symbols, userSave, orderSave, run } = fixture();
    const hints = [callHint({ receiverType: "User", receiverText: "a" })];
    const { relationships } = resolveHints(hints, symbols, undefined, undefined, true);
    const call = relationships.find((r) => r.relType === "calls" && r.source === run.id);
    expect(call?.target).toBe(userSave.id);
    expect(call?.target).not.toBe(orderSave.id);
  });
});
