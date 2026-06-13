/**
 * Query preprocessing for semantic search.
 * Normalizes user queries to improve embedding consistency and accuracy.
 * 
 * Requirements: 22.3 (input sanitization)
 */

/**
 * Preprocess a query string for semantic search.
 * 
 * Steps:
 * 1. Convert to lowercase — normalize case variations
 * 2. Remove punctuation — "authenticate?" → "authenticate"
 * 3. Normalize whitespace — multiple spaces → single space
 * 4. Trim — remove leading/trailing whitespace
 * 
 * This ensures consistent embeddings across query variations:
 * - "How do users authenticate?" → "how do users authenticate"
 * - "HOW DO USERS AUTHENTICATE?" → "how do users authenticate"
 * - "How  do  users  authenticate?" → "how do users authenticate"
 * 
 * Requirements: 22.3
 */
export function preprocessQuery(query: string): string {
  return query
    .toLowerCase()                    // Normalize case
    .replace(/[^\w\s]/g, " ")        // Remove punctuation, keep alphanumeric + spaces
    .replace(/\s+/g, " ")            // Normalize whitespace (multiple → single)
    .trim();                          // Remove leading/trailing whitespace
}

/**
 * Validate that a query is non-empty after preprocessing.
 * 
 * Requirements: 22.3
 */
export function isValidQuery(query: string): boolean {
  const preprocessed = preprocessQuery(query);
  return preprocessed.length > 0;
}
