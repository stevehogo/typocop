/**
 * D1 — `typocop setup`: idempotently merge the auto-augment PreToolUse hook
 * into a Claude Code `settings.json`.
 *
 * This module is split into a PURE merge ({@link mergeTypocopHook}) and a thin
 * filesystem wrapper ({@link runSetup}) so the merge logic — the part with all
 * the idempotency/preservation invariants — is unit-testable without touching
 * disk.
 *
 * Claude Code settings shape (the slice we care about):
 *   { "hooks": { "PreToolUse": [ { "matcher": "...", "hooks": [ { "type": "command", "command": "..." } ] } ] } }
 *
 * The augment hook matches the search tools (`Grep|Glob|Bash`) and runs a
 * single `command`. Idempotency key: a PreToolUse entry whose inner hooks
 * already contain our exact `command` string. We never duplicate, never clobber
 * unrelated hooks, and preserve every other settings key untouched.
 */

/** Claude Code settings — only the fields we read/write are typed; the rest is preserved verbatim. */
export interface ClaudeSettings {
  hooks?: {
    PreToolUse?: HookMatcherEntry[];
    [event: string]: unknown;
  };
  [key: string]: unknown;
}

export interface HookMatcherEntry {
  matcher?: string;
  hooks?: HookCommand[];
  [key: string]: unknown;
}

export interface HookCommand {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

/** The tool matcher the augment hook subscribes to (search tools only). */
export const TYPOCOP_HOOK_MATCHER = "Grep|Glob|Bash";

/**
 * Pure, idempotent merge of the typocop augment hook into `existing` settings.
 *
 * Returns the merged settings plus `changed` — `false` when the exact hook
 * command is already wired (so the caller can skip the write and report
 * "already configured"). Preserves all unrelated settings keys, unrelated hook
 * events, and unrelated PreToolUse matcher entries.
 *
 * @param existing      Parsed settings object (may be `{}` for a fresh file).
 * @param hookCommand   The shell command Claude Code should run for the hook.
 */
export function mergeTypocopHook(
  existing: ClaudeSettings,
  hookCommand: string,
): { settings: ClaudeSettings; changed: boolean } {
  const preToolUse: HookMatcherEntry[] = Array.isArray(existing.hooks?.PreToolUse)
    ? existing.hooks.PreToolUse
    : [];

  // Already wired? An entry exists whose inner hooks include our exact command.
  const alreadyWired = preToolUse.some(
    (entry) =>
      Array.isArray(entry.hooks) &&
      entry.hooks.some((h) => h.type === "command" && h.command === hookCommand),
  );
  if (alreadyWired) {
    return { settings: existing, changed: false };
  }

  // Prefer to attach to an existing entry that already uses our matcher, so we
  // don't proliferate matcher entries; otherwise append a fresh one.
  const ourCommand: HookCommand = { type: "command", command: hookCommand };
  const matchingIdx = preToolUse.findIndex((entry) => entry.matcher === TYPOCOP_HOOK_MATCHER);

  let nextPreToolUse: HookMatcherEntry[];
  if (matchingIdx >= 0) {
    const target = preToolUse[matchingIdx];
    const targetHooks = Array.isArray(target.hooks) ? target.hooks : [];
    const updated: HookMatcherEntry = { ...target, hooks: [...targetHooks, ourCommand] };
    nextPreToolUse = preToolUse.map((e, i) => (i === matchingIdx ? updated : e));
  } else {
    nextPreToolUse = [
      ...preToolUse,
      { matcher: TYPOCOP_HOOK_MATCHER, hooks: [ourCommand] },
    ];
  }

  const settings: ClaudeSettings = {
    ...existing,
    hooks: {
      ...(existing.hooks ?? {}),
      PreToolUse: nextPreToolUse,
    },
  };
  return { settings, changed: true };
}
