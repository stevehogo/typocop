/**
 * Identifier tokenisation — shared, leaf-safe (no `node:` builtins, no upward
 * imports). Both the indexing keyword extractor
 * (`application/indexing/search/keywords.ts`) and the D1 augment engine
 * (`application/querying/augment.ts`) split identifiers the SAME way, so the
 * augment path probes the graph with exactly the tokens the keyword index was
 * built from. Lives in `platform/` so the two `application/*` siblings can both
 * depend on it without violating the `app-no-sibling` layering rule.
 */

/**
 * Splits a camelCase, PascalCase, snake_case, or kebab-case identifier into
 * lowercase word parts longer than one character.
 *
 * Examples:
 * - `getUserById`  → `["get", "user", "by", "id"]`
 * - `XMLParser`    → `["xml", "parser"]`
 * - `user_repo-v2` → `["user", "repo", "v2"]`
 */
export function splitIdentifier(name: string): string[] {
  // Handle snake_case and kebab-case first
  const withSpaces = name
    .replace(/_+/g, " ")
    .replace(/-+/g, " ")
    // Insert space before uppercase letters preceded by lowercase (camelCase)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    // Insert space before uppercase letters followed by lowercase (e.g. XMLParser → XML Parser)
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");

  return withSpaces
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 1);
}
