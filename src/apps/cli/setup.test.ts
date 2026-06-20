/**
 * D1 — mergeTypocopHook tests: idempotent merge that preserves unrelated
 * settings, unrelated hook events, and unrelated PreToolUse matcher entries.
 */
import { describe, it, expect } from "vitest";
import { mergeTypocopHook, TYPOCOP_HOOK_MATCHER, type ClaudeSettings } from "./setup.js";

const CMD = "typocop-hook";

describe("mergeTypocopHook", () => {
  it("installs the hook into a fresh (empty) settings object", () => {
    const { settings, changed } = mergeTypocopHook({}, CMD);
    expect(changed).toBe(true);
    expect(settings.hooks?.PreToolUse).toEqual([
      { matcher: TYPOCOP_HOOK_MATCHER, hooks: [{ type: "command", command: CMD }] },
    ]);
  });

  it("is idempotent — re-merging an already-wired settings reports no change", () => {
    const first = mergeTypocopHook({}, CMD);
    const second = mergeTypocopHook(first.settings, CMD);
    expect(second.changed).toBe(false);
    expect(second.settings).toBe(first.settings); // unchanged reference
    // Exactly one hook entry, not duplicated.
    expect(second.settings.hooks?.PreToolUse).toHaveLength(1);
    expect(second.settings.hooks?.PreToolUse?.[0].hooks).toHaveLength(1);
  });

  it("preserves unrelated top-level settings keys", () => {
    const existing: ClaudeSettings = {
      model: "claude-opus",
      permissions: { allow: ["Bash(ls:*)"] },
    };
    const { settings } = mergeTypocopHook(existing, CMD);
    expect(settings.model).toBe("claude-opus");
    expect(settings.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect(settings.hooks?.PreToolUse).toHaveLength(1);
  });

  it("preserves unrelated hook events (e.g. PostToolUse)", () => {
    const existing: ClaudeSettings = {
      hooks: {
        PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "other" }] }],
      },
    };
    const { settings, changed } = mergeTypocopHook(existing, CMD);
    expect(changed).toBe(true);
    expect(settings.hooks?.PostToolUse).toEqual([
      { matcher: "Edit", hooks: [{ type: "command", command: "other" }] },
    ]);
    expect(settings.hooks?.PreToolUse).toHaveLength(1);
  });

  it("preserves unrelated PreToolUse matcher entries and appends ours", () => {
    const existing: ClaudeSettings = {
      hooks: {
        PreToolUse: [
          { matcher: "Write", hooks: [{ type: "command", command: "lint" }] },
        ],
      },
    };
    const { settings, changed } = mergeTypocopHook(existing, CMD);
    expect(changed).toBe(true);
    const entries = settings.hooks?.PreToolUse ?? [];
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ matcher: "Write", hooks: [{ type: "command", command: "lint" }] });
    expect(entries[1]).toEqual({
      matcher: TYPOCOP_HOOK_MATCHER,
      hooks: [{ type: "command", command: CMD }],
    });
  });

  it("attaches to an existing entry that already uses our matcher rather than duplicating it", () => {
    const existing: ClaudeSettings = {
      hooks: {
        PreToolUse: [
          { matcher: TYPOCOP_HOOK_MATCHER, hooks: [{ type: "command", command: "someoneElse" }] },
        ],
      },
    };
    const { settings, changed } = mergeTypocopHook(existing, CMD);
    expect(changed).toBe(true);
    const entries = settings.hooks?.PreToolUse ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0].hooks).toEqual([
      { type: "command", command: "someoneElse" },
      { type: "command", command: CMD },
    ]);
  });

  it("does not mutate the input settings object", () => {
    const existing: ClaudeSettings = { hooks: { PreToolUse: [] } };
    const snapshot = JSON.parse(JSON.stringify(existing));
    mergeTypocopHook(existing, CMD);
    expect(existing).toEqual(snapshot);
  });
});
