import { describe, it, expect } from 'vitest';
import { isValidPath, containsTraversalPattern } from './validate-path.js';

describe('isValidPath', () => {
  it('returns false for non-string input', () => {
    expect(isValidPath(null as any)).toBe(false);
    expect(isValidPath(undefined as any)).toBe(false);
    expect(isValidPath(123 as any)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isValidPath('')).toBe(false);
  });

  it('returns true for valid relative paths', () => {
    expect(isValidPath('src/utils/helper.ts')).toBe(true);
    expect(isValidPath('src/index.ts')).toBe(true);
    expect(isValidPath('package.json')).toBe(true);
    expect(isValidPath('tests/fixtures/sample.ts')).toBe(true);
  });

  it('returns false for paths with ../ traversal', () => {
    expect(isValidPath('../etc/passwd')).toBe(false);
    expect(isValidPath('../../config.ts')).toBe(false);
    expect(isValidPath('src/../../../etc/passwd')).toBe(false);
  });

  it('returns false for paths with ..\\ traversal (Windows)', () => {
    expect(isValidPath('..\\windows\\system32')).toBe(false);
    expect(isValidPath('src\\..\\..\\config')).toBe(false);
  });

  it('returns false for URL-encoded traversal attempts', () => {
    expect(isValidPath('%2e%2e/etc/passwd')).toBe(false);
    expect(isValidPath('%252e%252e/etc/passwd')).toBe(false);
    expect(isValidPath('..%2fetc/passwd')).toBe(false);
  });

  it('returns false for null byte injection', () => {
    expect(isValidPath('file.txt\0.jpg')).toBe(false);
    expect(isValidPath('src/\0/file.ts')).toBe(false);
  });

  it('returns false for absolute paths', () => {
    expect(isValidPath('/etc/passwd')).toBe(false);
    expect(isValidPath('/usr/local/bin')).toBe(false);
    expect(isValidPath('\\windows\\system32')).toBe(false);
  });

  it('returns false for Windows absolute paths', () => {
    expect(isValidPath('C:\\Windows\\System32')).toBe(false);
    expect(isValidPath('D:\\data\\file.txt')).toBe(false);
    expect(isValidPath('c:/windows/system32')).toBe(false);
  });

  it('returns false for paths with invalid characters', () => {
    expect(isValidPath('file<name>.txt')).toBe(false);
    expect(isValidPath('file>name.txt')).toBe(false);
    expect(isValidPath('file|name.txt')).toBe(false);
    expect(isValidPath('file?name.txt')).toBe(false);
    expect(isValidPath('file*name.txt')).toBe(false);
    expect(isValidPath('file"name.txt')).toBe(false);
  });

  it('returns false for paths that normalize to parent directory', () => {
    expect(isValidPath('src/../config.ts')).toBe(false);
    expect(isValidPath('./../../etc/passwd')).toBe(false);
  });

  it('returns true for paths with dots in filenames', () => {
    expect(isValidPath('file.test.ts')).toBe(true);
    expect(isValidPath('src/utils/helper.spec.ts')).toBe(true);
    expect(isValidPath('.gitignore')).toBe(true);
    expect(isValidPath('.config/settings.json')).toBe(true);
  });

  it('returns true for paths with current directory reference', () => {
    expect(isValidPath('./src/index.ts')).toBe(true);
    expect(isValidPath('./package.json')).toBe(true);
  });
});

describe('containsTraversalPattern', () => {
  it('returns false for non-string input', () => {
    expect(containsTraversalPattern(null as any)).toBe(false);
    expect(containsTraversalPattern(undefined as any)).toBe(false);
  });

  it('returns false for clean paths', () => {
    expect(containsTraversalPattern('src/utils/helper.ts')).toBe(false);
    expect(containsTraversalPattern('package.json')).toBe(false);
    expect(containsTraversalPattern('./src/index.ts')).toBe(false);
  });

  it('returns true for ../ patterns', () => {
    expect(containsTraversalPattern('../etc/passwd')).toBe(true);
    expect(containsTraversalPattern('../../config')).toBe(true);
    expect(containsTraversalPattern('src/../../../etc')).toBe(true);
  });

  it('returns true for ..\\ patterns', () => {
    expect(containsTraversalPattern('..\\windows')).toBe(true);
    expect(containsTraversalPattern('src\\..\\config')).toBe(true);
  });

  it('returns true for URL-encoded traversal', () => {
    expect(containsTraversalPattern('%2e%2e/etc')).toBe(true);
    expect(containsTraversalPattern('%252e%252e/etc')).toBe(true);
    expect(containsTraversalPattern('..%2fetc')).toBe(true);
    expect(containsTraversalPattern('..%5cwindows')).toBe(true);
  });

  it('returns false for dots in filenames', () => {
    expect(containsTraversalPattern('file.test.ts')).toBe(false);
    expect(containsTraversalPattern('.gitignore')).toBe(false);
    expect(containsTraversalPattern('src/helper.spec.ts')).toBe(false);
  });
});
