# Requirements: Two-Phase Filesystem Walker — Memory Safety at Scale

Spec for improving `src/indexer/structure/index.ts` based on gap analysis in `docs/improve-parser.md` (#7).

**Related documents:**
- [Design](./design.md)
- [Tasks](./tasks.md)

---

## Context

The current walker already implements the two-phase pattern (stat-only walk → on-demand reads). This spec addresses the remaining gaps that matter at scale: progress observability, symlink safety, and property-based correctness guarantees.

---

## Requirements

### REQ-1: Progress Observability

WHEN `walkFileTree` is scanning a large repository,  
THE SYSTEM SHALL accept an optional `onProgress` callback `(scanned: number, total: number, filePath: string) => void` and invoke it after each file is stat-checked.

**Rationale**: The legacy `walkRepositoryPaths` exposes this callback. Without it, CLI output is silent during long scans — users cannot distinguish a hanging process from a slow one.

**Acceptance criteria**:
- Callback is invoked once per file processed (including skipped files)
- `scanned` increments monotonically from 1 to `total`
- `total` reflects the count of candidate paths before stat-checking
- Callback is never invoked when input is empty

---

### REQ-2: Symlink Safety

WHEN `walkFileTree` encounters a symbolic link during directory traversal,  
THE SYSTEM SHALL skip it without following it.

**Rationale**: Following symlinks can cause infinite loops (circular symlinks) or double-indexing of files already covered by their canonical path.

**Acceptance criteria**:
- Symlinks to files are not added to the result
- Symlinks to directories are not recursed into
- No error is thrown when a symlink is encountered

---

### REQ-3: Stat-Phase Size Filter is the Only Content Gate

WHEN a file's size exceeds `MAX_FILE_SIZE` during the stat phase,  
THE SYSTEM SHALL exclude it from the returned `FileNode[]` before any content is read.

**Rationale**: Already implemented, but must be covered by a property test to prevent regression.

**Acceptance criteria**:
- No `FileNode` in the result has `size > MAX_FILE_SIZE`
- The constraint holds for any combination of file sizes (property test)

---

### REQ-4: `readFileContents` Isolation

WHEN `readFileContents` is called with a path that fails to read,  
THE SYSTEM SHALL silently skip that path and continue reading the remaining paths.

**Rationale**: Already implemented, but must be covered by a property test.

**Acceptance criteria**:
- A single failing read does not abort the batch
- The returned `Map` contains only successfully read paths
- The constraint holds for any subset of failing paths (property test)

---

### REQ-5: No Content in `walkFileTree` Return Value

WHEN `walkFileTree` completes,  
THE SYSTEM SHALL return only `FileNode[]` — never file content.

**Rationale**: The entire point of the two-phase design is to keep memory proportional to file count, not file content. `FileNode` must not gain a `content` field.

**Acceptance criteria**:
- `FileNode` type has exactly `{ path: string; size: number; language: Language }` — no `content` field
- TypeScript compiler enforces this at the type level
