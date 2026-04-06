# Tasks: Two-Phase Filesystem Walker — Memory Safety at Scale

Part of the [Requirements](./requirements.md) | [Design](./design.md).

---

## Tasks

- [x] 1. Add `onProgress` callback to `walkFileTree`
  _Skills: `typescript-expert`, `clean-code`_
  - [x] 1.1 Export `WalkProgressCallback` type from `src/indexer/structure/index.ts`
  - [x] 1.2 Add optional `onProgress` parameter to `walkFileTree` signature
  - [x] 1.3 Capture `total` (candidate path count) before the stat-batch loop
  - [x] 1.4 Invoke `onProgress(scanned, total, filePath)` after each result in the batch loop
  - _Requirements: REQ-1_

- [x] 2. Make symlink skipping explicit and tested
  _Skills: `typescript-expert`, `clean-code`_
  - [x] 2.1 Add inline comment in `collect()` explaining that symlinks are skipped because `isFile()` and `isDirectory()` both return false for them
  - [x] 2.2 Add unit test: symlink dirent produces no `FileNode` in result
  - _Requirements: REQ-2_

- [x] 3. Write property tests for walker invariants
  _Skills: `testing-patterns`, `tdd-workflow`_
  - [x] 3.1 **Property: size gate** — for any set of mocked files, no returned `FileNode` has `size > MAX_FILE_SIZE`
  - [x] 3.2 **Property: read isolation** — for any subset of failing paths, `readFileContents` result contains only successful reads and its size equals `totalPaths - failingPaths`
  - [x] 3.3 Add `onProgress` unit test: callback receives monotonically increasing `scanned`, final call has `scanned === total`
  - _Requirements: REQ-3, REQ-4_
