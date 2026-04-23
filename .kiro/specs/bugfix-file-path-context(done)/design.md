# File Path Context Loss Bugfix Design

## Overview

The parser stores file paths as relative paths without the scan path prefix, causing downstream file operations to fail. When the indexing pipeline processes files from a scan path like `/home/user/project`, symbols are created with incomplete `filePath` properties (e.g., `lib/net/request-header.ts` instead of `/home/user/project/lib/net/request-header.ts`). This breaks Phase 3 reference resolution and any downstream code that attempts to read file content using the stored paths.

The fix requires passing the full path context through the symbol extraction pipeline so that symbols and relationship hints contain complete, resolvable file paths.

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug — when `extractAllSymbols` receives relative file paths and a `rootPath` parameter but passes only the relative path to extraction functions
- **Property (P)**: The desired behavior when the bug condition holds — symbols and hints should contain complete absolute paths
- **Preservation**: Existing symbol extraction logic, deduplication, and fallback mechanisms must continue to work unchanged
- **rootPath**: The scan path prefix passed to `extractAllSymbols` (e.g., `/home/user/project`)
- **fileNode.path**: The relative path of a file within the scan root (e.g., `lib/net/request-header.ts`)
- **fullPath**: The concatenation of `rootPath` and `fileNode.path` (e.g., `/home/user/project/lib/net/request-header.ts`)
- **extractSymbolsWithQueries**: The function in `src/parser/extract-symbols.ts` that extracts symbols and relationship hints using tree-sitter queries
- **RawRelationshipHint**: The interface representing import, call, and heritage hints with a `sourceFile` property

## Bug Details

### Bug Condition

The bug manifests when `extractAllSymbols` in Phase 2 processes files with relative paths and a `rootPath` parameter. The function resolves the full path for file I/O (line 97 in `src/indexer/parsing/index.ts`), but then passes only the relative path to `extractSymbolsWithQueries` (line 99). This causes all symbols and relationship hints to be created with incomplete file paths.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { fileNodes: FileNode[], rootPath: string }
  OUTPUT: boolean
  
  RETURN fileNodes.length > 0
         AND rootPath is not empty
         AND extractSymbolsWithQueries is called with fileNode.path (relative)
         AND NOT called with path.resolve(rootPath, fileNode.path) (absolute)
END FUNCTION
```

### Examples

**Example 1: TypeScript file in nested directory**
- Scan path: `/home/user/project`
- File: `src/services/auth.ts`
- Current (buggy) behavior: Symbol created with `filePath: "src/services/auth.ts"`
- Expected behavior: Symbol created with `filePath: "/home/user/project/src/services/auth.ts"`
- Impact: Phase 3 cannot resolve imports because the path is incomplete

**Example 2: Relationship hints with incomplete paths**
- When parsing `src/controllers/user.ts` that imports from `../services/auth`
- Current (buggy) behavior: Hint created with `sourceFile: "src/controllers/user.ts"`
- Expected behavior: Hint created with `sourceFile: "/home/user/project/src/controllers/user.ts"`
- Impact: Import resolution in Phase 3 fails because the source file path cannot be resolved

**Example 3: Fallback extraction path**
- When query compilation fails and fallback `extractSymbols` is used
- Current (buggy) behavior: Fallback symbols also get relative paths
- Expected behavior: Fallback symbols should also get absolute paths
- Impact: Inconsistent behavior between query-based and fallback extraction

**Edge case: Symbol ID generation**
- Symbol IDs are generated using `filePath` (line 155 in `extract-symbols.ts`)
- Current (buggy) behavior: IDs use relative paths, causing collisions across different scan roots
- Expected behavior: IDs use absolute paths, ensuring uniqueness across all scans

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Symbol extraction logic (name, kind, location line/column, visibility, modifiers) must remain identical
- Relationship hint extraction (import, call, heritage) must continue to work correctly
- Deduplication by symbol ID must continue to work
- Fallback extraction when query compilation fails must continue to work
- Error handling for unparseable files must remain unchanged
- Skipping of large files must remain unchanged

**Scope:**
All aspects of symbol and hint extraction must be preserved. The only change is that the `filePath` property in symbols and the `sourceFile` property in hints should contain absolute paths instead of relative paths.

## Hypothesized Root Cause

Based on the bug description and code analysis, the root causes are:

1. **Incomplete Path Passing in Phase 2**: The `extractAllSymbols` function resolves the full path for file I/O (line 97) but passes only the relative path to `extractSymbolsWithQueries` (line 99). The full path is not propagated to the extraction functions.

2. **Missing Path Concatenation in Extraction Functions**: The `extractSymbolsWithQueries` and `extractSymbols` functions receive only the relative path and use it directly in symbol creation and hint generation, without access to the `rootPath` context.

3. **Fallback Path Not Updated**: When query compilation fails, the fallback `extractSymbols` function is called with the same relative path, perpetuating the bug.

4. **Symbol ID Generation Uses Relative Path**: The symbol ID generation (line 155 in `extract-symbols.ts`) uses the relative path, which can cause collisions when the same file is scanned from different root paths.

## Correctness Properties

Property 1: Bug Condition - File Path Completeness

_For any_ input where the bug condition holds (relative paths passed to extraction functions), the fixed `extractAllSymbols` function SHALL pass the complete absolute path to `extractSymbolsWithQueries` and `extractSymbols`, ensuring all symbols and hints contain the full path context.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4**

Property 2: Preservation - Extraction Logic Unchanged

_For any_ input where the bug condition does NOT hold (or after the fix is applied), the fixed code SHALL produce symbols with identical names, kinds, locations, visibility, and modifiers as the original code, preserving all extraction logic.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `src/indexer/parsing/index.ts`

**Function**: `extractAllSymbols`

**Specific Changes**:

1. **Pass Full Path to Query-Based Extraction** (line 99):
   - Change: `extractSymbolsWithQueries(ast, fileNode.path, fileNode.language, parser)`
   - To: `extractSymbolsWithQueries(ast, fullPath, fileNode.language, parser)`
   - Reason: Ensures symbols and hints contain the complete absolute path

2. **Pass Full Path to Fallback Extraction** (line 108):
   - Change: `extractSymbols(ast, fileNode.path)`
   - To: `extractSymbols(ast, fullPath)`
   - Reason: Ensures fallback symbols also get absolute paths for consistency

3. **Update Symbol ID Generation** (line 112):
   - Change: `generateSymbolId(sym.location.filePath, ...)`
   - To: Use the full path in ID generation
   - Reason: Ensures symbol IDs are unique across different scan roots

**File**: `src/parser/extract-symbols.ts`

**Functions**: `extractSymbolsWithQueries`, `extractSymbols`

**Specific Changes**:

1. **No changes required** — These functions already use the `filePath` parameter correctly. They just need to receive the full path from the caller.

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis.

**Test Plan**: Write tests that parse files from a scan path and verify that symbols contain the full path. Run these tests on the UNFIXED code to observe failures and confirm the bug.

**Test Cases**:
1. **Single File Extraction**: Parse a single TypeScript file from a scan path and verify the symbol's `filePath` is absolute (will fail on unfixed code)
2. **Nested Directory Extraction**: Parse a file in a nested directory and verify the full path is preserved (will fail on unfixed code)
3. **Relationship Hints**: Parse a file with imports and verify hints contain the full source file path (will fail on unfixed code)
4. **Symbol ID Uniqueness**: Parse the same file from different scan roots and verify symbol IDs are unique (will fail on unfixed code)

**Expected Counterexamples**:
- Symbols have relative paths instead of absolute paths
- Relationship hints have relative source file paths
- Symbol IDs may collide when the same file is scanned from different roots

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := extractAllSymbols_fixed(input.fileNodes, input.rootPath)
  FOR ALL symbol IN result.symbols DO
    ASSERT symbol.location.filePath is absolute path
    ASSERT symbol.location.filePath starts with input.rootPath
  END FOR
  FOR ALL hint IN result.hints DO
    ASSERT hint.sourceFile is absolute path
    ASSERT hint.sourceFile starts with input.rootPath
  END FOR
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs, the fixed function produces symbols with identical extraction logic as the original function.

**Pseudocode:**
```
FOR ALL input DO
  result_original := extractAllSymbols_original(input.fileNodes, input.rootPath)
  result_fixed := extractAllSymbols_fixed(input.fileNodes, input.rootPath)
  FOR ALL symbol_original, symbol_fixed IN zip(result_original.symbols, result_fixed.symbols) DO
    ASSERT symbol_original.name = symbol_fixed.name
    ASSERT symbol_original.kind = symbol_fixed.kind
    ASSERT symbol_original.location.startLine = symbol_fixed.location.startLine
    ASSERT symbol_original.visibility = symbol_fixed.visibility
    ASSERT symbol_original.modifiers = symbol_fixed.modifiers
  END FOR
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across different file structures
- It catches edge cases that manual unit tests might miss
- It provides strong guarantees that extraction logic is unchanged

**Test Plan**: Generate random file structures and verify that symbol extraction logic (name, kind, location, visibility, modifiers) remains identical before and after the fix.

**Test Cases**:
1. **Symbol Name Preservation**: Verify extracted symbol names are identical
2. **Symbol Kind Preservation**: Verify extracted symbol kinds are identical
3. **Symbol Location Preservation**: Verify line/column numbers are identical
4. **Symbol Visibility Preservation**: Verify visibility modifiers are identical
5. **Hint Count Preservation**: Verify the number of extracted hints is identical

### Unit Tests

- Test that `extractAllSymbols` passes the full path to extraction functions
- Test that symbols contain absolute paths after extraction
- Test that relationship hints contain absolute source file paths
- Test that symbol IDs are unique across different scan roots
- Test that fallback extraction also receives the full path
- Test that deduplication still works with absolute paths

### Property-Based Tests

- Generate random file structures and verify all symbols have absolute paths
- Generate random scan paths and verify symbols are correctly prefixed
- Generate random nested directories and verify path resolution is correct
- Test that extraction logic (name, kind, visibility) is preserved across all inputs

### Integration Tests

- Test full indexing pipeline with files from different scan paths
- Test that Phase 3 reference resolution works with absolute paths
- Test that file content can be read using the stored absolute paths
- Test that the same codebase scanned from different roots produces unique symbol IDs
