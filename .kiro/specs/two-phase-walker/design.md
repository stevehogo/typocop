# Design: Two-Phase Filesystem Walker — Memory Safety at Scale

Part of the [Requirements](./requirements.md).

---

## What Changes

Only `src/indexer/structure/index.ts` and `src/indexer/structure/index.test.ts` are modified. No new files.

---

## API Changes

### `walkFileTree` — add optional `onProgress`

```typescript
export type WalkProgressCallback = (
  scanned: number,
  total: number,
  filePath: string
) => void;

export const walkFileTree = async (
  rootPath: string,
  onProgress?: WalkProgressCallback
): Promise<FileNode[]>
```

The callback is invoked in the stat-batch loop, after each `Promise.allSettled` result is processed. `total` is set once — the count of candidate relative paths collected during the recursive `collect` pass.

### Symlink guard — `entry.isFile()` check

The current `collect` function already checks `entry.isDirectory()` and `entry.isFile()`. Symlinks return `false` for both, so they are already skipped implicitly. The fix is to make this explicit with a comment and a test.

---

## Memory Model

```
collect()          → string[]          ~10MB / 100K files
stat batch         → FileNode[]        ~30MB / 100K files  (path + size + language)
readFileContents() → Map<path,content> loaded on demand, caller controls scope
```

`walkFileTree` never holds file content. `readFileContents` is called by Phase 2 with only the paths it needs for the current batch.

---

## Invariants (enforced by property tests)

| Invariant | Test type |
|-----------|-----------|
| No `FileNode.size > MAX_FILE_SIZE` | `fc.property` |
| `readFileContents` result contains only successful reads | `fc.property` |
| `onProgress` scanned count is monotonically increasing | unit test |
| Symlinks produce no `FileNode` entries | unit test |
