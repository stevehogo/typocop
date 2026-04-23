/**
 * Levenshtein edit-distance implementation using single-row dynamic programming.
 * Space complexity: O(min(m, n)) where m and n are the input string lengths.
 * Requirements: 2.5
 */

/**
 * Compute the Levenshtein edit distance between two strings.
 *
 * Properties:
 * - Symmetric: levenshteinDistance(a, b) === levenshteinDistance(b, a)
 * - Identity: levenshteinDistance(x, x) === 0
 * - Non-negative: levenshteinDistance(a, b) >= 0
 *
 * Uses a single-row DP approach for O(min(m, n)) space.
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Use single-row DP for O(min(m,n)) space
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}
