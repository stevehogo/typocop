// Query sanitization for natural language inputs (Req 22.3)

/**
 * Malicious patterns to detect and remove from natural language queries.
 * These patterns could be used for injection attacks against graph databases.
 */
const MALICIOUS_PATTERNS = [
  // Cypher injection patterns - match full clauses with parentheses
  /MATCH\s*\([^)]*\)/gi,
  /CREATE\s*\([^)]*\)/gi,
  /DELETE\s+\w+/gi,
  /DETACH\s+DELETE\s+\w+/gi,
  /MERGE\s*\([^)]*\)/gi,
  /SET\s+\w+\s*=[^;]*/gi,
  /REMOVE\s+\w+/gi,
  /DROP\s+\w+/gi,
  
  // SQL injection patterns (for vector store queries)
  /;\s*DROP\s+/gi,
  /;\s*DELETE\s+FROM/gi,
  /;\s*UPDATE\s+/gi,
  /;\s*INSERT\s+INTO/gi,
  /UNION\s+SELECT/gi,
  /--[^\n]*/g,
  /\/\*.*?\*\//gs,
  
  // Command injection patterns
  /\$\([^)]*\)/g,
  /`[^`]*`/g,
  /\|\s*\w+/g,
  /&&\s*\w+/g,
  
  // Path traversal in queries
  /\.\.[\/\\]/g,
  
  // Script injection
  /<script[^>]*>.*?<\/script>/gis,
  /<iframe[^>]*>.*?<\/iframe>/gis,
  /javascript:/gi,
  /on\w+\s*=/gi,
];

/**
 * Sanitizes a natural language query by removing malicious patterns.
 * 
 * This function protects against injection attacks by:
 * - Removing Cypher query language patterns
 * - Removing SQL injection patterns
 * - Removing command injection patterns
 * - Removing script injection patterns
 * - Removing path traversal patterns
 * 
 * @param query - The raw natural language query from user input
 * @returns Sanitized query safe for graph database execution
 * 
 * @example
 * ```typescript
 * const userQuery = "Find auth functions; DROP TABLE users;";
 * const safe = sanitizeQuery(userQuery);
 * // Returns: "Find auth functions  TABLE users"
 * ```
 */
export function sanitizeQuery(query: string): string {
  if (typeof query !== 'string') {
    return '';
  }
  
  let sanitized = query;
  
  // Apply all malicious pattern removals
  for (const pattern of MALICIOUS_PATTERNS) {
    sanitized = sanitized.replace(pattern, '');
  }
  
  // Normalize whitespace
  sanitized = sanitized.replace(/\s+/g, ' ').trim();
  
  return sanitized;
}

/**
 * Checks if a string contains any malicious patterns.
 * Used for validation and property testing.
 * 
 * @param text - The text to check for malicious patterns
 * @returns true if malicious patterns are detected, false otherwise
 */
export function containsMaliciousPatterns(text: string): boolean {
  if (typeof text !== 'string') {
    return false;
  }
  
  return MALICIOUS_PATTERNS.some(pattern => pattern.test(text));
}
