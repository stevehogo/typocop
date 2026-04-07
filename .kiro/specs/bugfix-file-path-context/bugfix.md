# Bugfix Requirements Document: File Path Context Loss

## Introduction

The parser stores file paths as relative paths (e.g., `lib/net/request-header.ts`) without including the scan path prefix that was passed via the `--path` parameter. This causes critical failures when Kiro or other components try to read file content later because they don't have the full path context needed to locate files on disk.

The bug affects the entire parsing pipeline, particularly the `extractAllSymbols` function in Phase 2, where symbols are created with incomplete `filePath` properties. This breaks downstream operations that depend on being able to resolve file locations.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the parser processes files from a scan path like `/home/user/project` THEN the parser stores only the relative path (e.g., `lib/net/request-header.ts`) in the symbol's `location.filePath` property without the scan path prefix

1.2 WHEN downstream code attempts to read file content using the stored relative path THEN the file read operation fails because the path is incomplete and cannot be resolved to an actual file location on disk

1.3 WHEN the `extractAllSymbols` function receives `FileNode[]` with relative paths and a `rootPath` parameter THEN it passes only the relative path to `extractSymbolsWithQueries` instead of concatenating it with the `rootPath` to create a complete path

1.4 WHEN relationship hints are created during symbol extraction THEN the `sourceFile` property in `RawRelationshipHint` is set to the relative path without the scan path prefix, causing import and call resolution to fail in Phase 3

### Expected Behavior (Correct)

2.1 WHEN the parser processes files from a scan path like `/home/user/project` THEN the parser stores the complete absolute path (e.g., `/home/user/project/lib/net/request-header.ts`) in the symbol's `location.filePath` property

2.2 WHEN downstream code attempts to read file content using the stored path THEN the file read operation succeeds because the path is complete and can be directly resolved to the file location on disk

2.3 WHEN the `extractAllSymbols` function receives `FileNode[]` with relative paths and a `rootPath` parameter THEN it concatenates the `rootPath` with each `fileNode.path` to create a complete path before passing it to `extractSymbolsWithQueries`

2.4 WHEN relationship hints are created during symbol extraction THEN the `sourceFile` property in `RawRelationshipHint` is set to the complete absolute path, allowing import and call resolution to succeed in Phase 3

### Unchanged Behavior (Regression Prevention)

3.1 WHEN the parser processes files with supported languages (TypeScript, JavaScript, Python, PHP, Java, Go, Rust, C, C++, C#, Ruby, Swift) THEN the parser continues to correctly extract symbol names, kinds, locations, visibility, and modifiers

3.2 WHEN the parser encounters files with syntax errors THEN the parser continues to skip those files and log warnings without crashing the pipeline

3.3 WHEN the parser processes large files exceeding the size limit THEN the parser continues to skip those files as before

3.4 WHEN the parser processes files in ignored directories (node_modules, .git, dist, etc.) THEN the parser continues to skip those files as before

3.5 WHEN the symbol deduplication logic runs THEN it continues to correctly identify and remove duplicate symbols based on their IDs

3.6 WHEN the pipeline is called with different root paths THEN the parser continues to work correctly regardless of the absolute path used as the scan root
