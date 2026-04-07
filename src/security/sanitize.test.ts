import { describe, it, expect } from 'vitest';
import { sanitizeQuery, containsMaliciousPatterns } from './sanitize.js';

describe('sanitizeQuery', () => {
  it('returns empty string for non-string input', () => {
    expect(sanitizeQuery(null as any)).toBe('');
    expect(sanitizeQuery(undefined as any)).toBe('');
    expect(sanitizeQuery(123 as any)).toBe('');
  });

  it('returns the same query when no malicious patterns are present', () => {
    const query = 'Find all authentication functions';
    expect(sanitizeQuery(query)).toBe(query);
  });

  it('removes Cypher MATCH patterns', () => {
    const query = 'Find auth MATCH (n) RETURN n';
    const sanitized = sanitizeQuery(query);
    expect(sanitized).not.toContain('MATCH');
    expect(sanitized).toBe('Find auth RETURN n');
  });

  it('removes Cypher CREATE patterns', () => {
    const query = 'Show users CREATE (n:User) RETURN n';
    const sanitized = sanitizeQuery(query);
    expect(sanitized).not.toContain('CREATE');
  });

  it('removes Cypher DELETE patterns', () => {
    const query = 'List nodes DELETE n';
    const sanitized = sanitizeQuery(query);
    expect(sanitized).not.toContain('DELETE');
  });

  it('removes SQL DROP TABLE patterns', () => {
    const query = 'Find users; DROP TABLE users;';
    const sanitized = sanitizeQuery(query);
    expect(sanitized).not.toContain('DROP');
    expect(sanitized).toBe('Find users; users;');
  });

  it('removes SQL UNION SELECT patterns', () => {
    const query = 'Search UNION SELECT * FROM passwords';
    const sanitized = sanitizeQuery(query);
    expect(sanitized).not.toContain('UNION SELECT');
  });

  it('removes command injection patterns with backticks', () => {
    const query = 'Find `rm -rf /` files';
    const sanitized = sanitizeQuery(query);
    expect(sanitized).not.toContain('`');
    expect(sanitized).toBe('Find files');
  });

  it('removes command injection patterns with $()', () => {
    const query = 'Search $(cat /etc/passwd) files';
    const sanitized = sanitizeQuery(query);
    expect(sanitized).not.toContain('$(');
  });

  it('removes path traversal patterns', () => {
    const query = 'Find files in ../../etc/passwd';
    const sanitized = sanitizeQuery(query);
    expect(sanitized).not.toContain('../');
  });

  it('removes script injection patterns', () => {
    const query = 'Search <script>alert("xss")</script> code';
    const sanitized = sanitizeQuery(query);
    expect(sanitized).not.toContain('<script>');
    expect(sanitized).not.toContain('</script>');
  });

  it('removes SQL comment patterns', () => {
    const query = 'Find users -- comment';
    const sanitized = sanitizeQuery(query);
    expect(sanitized).toBe('Find users');
  });

  it('normalizes whitespace after sanitization', () => {
    const query = 'Find    auth    functions';
    const sanitized = sanitizeQuery(query);
    expect(sanitized).toBe('Find auth functions');
  });

  it('handles multiple malicious patterns in one query', () => {
    const query = 'MATCH (n) DELETE n; DROP TABLE users; $(rm -rf /)';
    const sanitized = sanitizeQuery(query);
    expect(sanitized).not.toContain('MATCH');
    expect(sanitized).not.toContain('DELETE');
    expect(sanitized).not.toContain('DROP');
    expect(sanitized).not.toContain('$(');
  });

  it('preserves legitimate technical terms', () => {
    const query = 'Find functions that match authentication patterns';
    const sanitized = sanitizeQuery(query);
    expect(sanitized).toBe(query);
  });
});

describe('containsMaliciousPatterns', () => {
  it('returns false for non-string input', () => {
    expect(containsMaliciousPatterns(null as any)).toBe(false);
    expect(containsMaliciousPatterns(undefined as any)).toBe(false);
  });

  it('returns false for clean queries', () => {
    expect(containsMaliciousPatterns('Find authentication functions')).toBe(false);
    expect(containsMaliciousPatterns('Show all user classes')).toBe(false);
  });

  it('returns true for Cypher injection patterns', () => {
    expect(containsMaliciousPatterns('MATCH (n) RETURN n')).toBe(true);
    expect(containsMaliciousPatterns('CREATE (n:User)')).toBe(true);
    expect(containsMaliciousPatterns('DELETE n')).toBe(true);
  });

  it('returns true for SQL injection patterns', () => {
    expect(containsMaliciousPatterns('; DROP TABLE users')).toBe(true);
    expect(containsMaliciousPatterns('UNION SELECT * FROM')).toBe(true);
  });

  it('returns true for command injection patterns', () => {
    expect(containsMaliciousPatterns('$(cat /etc/passwd)')).toBe(true);
    expect(containsMaliciousPatterns('`rm -rf /`')).toBe(true);
  });

  it('returns true for script injection patterns', () => {
    expect(containsMaliciousPatterns('<script>alert(1)</script>')).toBe(true);
    expect(containsMaliciousPatterns('javascript:void(0)')).toBe(true);
  });
});

/**
 * Property 19: Input Sanitization
 * For any string input, sanitizeQuery output must never contain malicious patterns.
 * Validates: Req 22.3
 */
import { describe as describeProperty, it as itProperty } from 'vitest';
import * as fc from 'fast-check';

describeProperty('Property 19: Input Sanitization', () => {
  itProperty('sanitized output never contains malicious patterns', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const sanitized = sanitizeQuery(input);
        // After sanitization, containsMaliciousPatterns must return false
        return !containsMaliciousPatterns(sanitized);
      }),
      { numRuns: 100 },
    );
  });

  itProperty('sanitizeQuery output is always a string', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        return typeof sanitizeQuery(input) === 'string';
      }),
      { numRuns: 100 },
    );
  });

  itProperty('sanitizeQuery is idempotent — applying twice yields same result', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        return sanitizeQuery(sanitizeQuery(input)) === sanitizeQuery(input);
      }),
      { numRuns: 100 },
    );
  });
});
