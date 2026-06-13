// Path validation to prevent directory traversal attacks (Req 22.4)

import path from 'node:path';

/**
 * Directory traversal patterns that indicate malicious path manipulation.
 * These patterns are used to escape the intended directory structure.
 */
const TRAVERSAL_PATTERNS = [
  /\.\.[\/\\]/,           // ../ or ..\
  /\.[\/\\]\./,           // ./.
  /[\/\\]\.\.[\/\\]/,     // /../ or \..\
  /^\.\.$/,               // exactly ".."
  /^\.\.$/m,              // ".." on any line
  /%2e%2e[\/\\]/gi,       // URL-encoded ../
  /%252e%252e/gi,         // Double URL-encoded ..
  /\.\.%2f/gi,            // Mixed encoding
  /\.\.%5c/gi,            // Mixed encoding with backslash
];

/**
 * Additional suspicious patterns that may indicate path manipulation attempts.
 */
const SUSPICIOUS_PATTERNS = [
  /\0/,                   // Null byte injection
  /[<>"|?*]/,             // Invalid filename characters on Windows
  /^[\/\\]/,              // Absolute paths (should be relative)
  /^[a-zA-Z]:[\/\\]/,     // Windows absolute paths (C:\, D:\, etc.)
];

/**
 * Validates a file path to ensure it doesn't contain directory traversal patterns.
 * 
 * This function protects against path traversal attacks by:
 * - Detecting ../ and ..\ patterns
 * - Detecting URL-encoded traversal attempts
 * - Detecting null byte injection
 * - Detecting absolute paths
 * - Normalizing and validating the resolved path
 * 
 * @param filePath - The file path to validate
 * @returns true if the path is valid and safe, false otherwise
 * 
 * @example
 * ```typescript
 * isValidPath("src/utils/helper.ts")  // true
 * isValidPath("../../../etc/passwd")  // false
 * isValidPath("src/../config.ts")     // false
 * ```
 */
export function isValidPath(filePath: string): boolean {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return false;
  }
  
  // Check for traversal patterns
  if (containsTraversalPattern(filePath)) {
    return false;
  }
  
  // Check for suspicious patterns
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(filePath)) {
      return false;
    }
  }
  
  // Normalize the path and check if it tries to escape
  try {
    const normalized = path.normalize(filePath);
    
    // After normalization, path should not start with ..
    if (normalized.startsWith('..')) {
      return false;
    }
    
    // Path should not contain .. segments after normalization
    const segments = normalized.split(path.sep);
    if (segments.includes('..')) {
      return false;
    }
    
    return true;
  } catch {
    // If normalization fails, reject the path
    return false;
  }
}

/**
 * Checks if a path contains directory traversal patterns.
 * Used for validation and property testing.
 * 
 * @param filePath - The path to check for traversal patterns
 * @returns true if traversal patterns are detected, false otherwise
 */
export function containsTraversalPattern(filePath: string): boolean {
  if (typeof filePath !== 'string') {
    return false;
  }
  
  return TRAVERSAL_PATTERNS.some(pattern => pattern.test(filePath));
}
