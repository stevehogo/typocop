# Correctness Properties: Comprehensive File Ignore Rules

Part of the [Comprehensive File Ignore Rules Design](./design.md).

## Use Cases

### UC-1: Walker skips dependency directories

**Actor**: Phase 1 walker  
**Trigger**: `walkFileTree` encounters a directory named `node_modules`  
**Flow**: `shouldIgnorePath("node_modules/lodash/index.js")` → `true` → walker skips the entry  
**Outcome**: No files under `node_modules` appear in the `FileNode[]` result

### UC-2: Walker skips build output directories

**Actor**: Phase 1 walker  
**Trigger**: `walkFileTree` encounters `.next/`, `dist/`, `target/`  
**Flow**: `shouldIgnorePath(".next/server/app.js")` → `true`  
**Outcome**: Build artifacts never reach the parser

### UC-3: Walker skips lock files

**Actor**: Phase 1 walker  
**Trigger**: `walkFileTree` encounters `package-lock.json` at repo root  
**Flow**: `shouldIgnorePath("package-lock.json")` → `true`  
**Outcome**: Lock files are excluded; graph is not polluted with dependency metadata

### UC-4: Walker skips binary/media files

**Actor**: Phase 1 walker  
**Trigger**: `walkFileTree` encounters `assets/logo.png`  
**Flow**: `shouldIgnorePath("assets/logo.png")` → `true` (`.png` in `IGNORED_EXTENSIONS`)  
**Outcome**: Binary files never reach the parser, preventing parse errors

### UC-5: Walker skips TypeScript declaration files

**Actor**: Phase 1 walker  
**Trigger**: `walkFileTree` encounters `src/types/api.d.ts`  
**Flow**: `shouldIgnorePath("src/types/api.d.ts")` → `true` (`.d.ts` pattern)  
**Outcome**: Declaration files (generated, not source) are excluded

### UC-6: Walker skips minified bundles

**Actor**: Phase 1 walker  
**Trigger**: `walkFileTree` encounters `public/app.min.js`  
**Flow**: `shouldIgnorePath("public/app.min.js")` → `true` (compound ext `.min.js`)  
**Outcome**: Minified files are excluded; graph contains only source symbols

### UC-7: Walker indexes source files

**Actor**: Phase 1 walker  
**Trigger**: `walkFileTree` encounters `src/utils/ignore.ts`  
**Flow**: `shouldIgnorePath("src/utils/ignore.ts")` → `false`  
**Outcome**: Source file is included in `FileNode[]` and proceeds to parsing

### UC-8: Cross-platform path normalization

**Actor**: Phase 1 walker on Windows  
**Trigger**: `path.relative` returns `"node_modules\\lodash\\index.js"`  
**Flow**: `shouldIgnorePath` normalizes `\` → `/` before splitting  
**Outcome**: Windows paths are filtered correctly, same as POSIX paths

## Correctness Properties

### Property 1: Directory segment ignore is total

For any path containing a segment that is in `DEFAULT_IGNORE_LIST`, `shouldIgnorePath` returns `true`.

```typescript
fc.assert(fc.property(
  fc.constantFrom(...DEFAULT_IGNORE_LIST),
  fc.array(fc.string({ minLength: 1 }).filter(s => !s.includes("/") && !s.includes("\\"))),
  fc.array(fc.string({ minLength: 1 }).filter(s => !s.includes("/") && !s.includes("\\"))),
  fc.string({ minLength: 1 }).filter(s => !s.includes("/")),
  (ignoredSegment, prefix, suffix, filename) => {
    const path = [...prefix, ignoredSegment, ...suffix, filename].join("/");
    return shouldIgnorePath(path) === true;
  }
))
```

### Property 2: Exact filename ignore is total

For any path whose filename (last segment) is in `IGNORED_FILES`, `shouldIgnorePath` returns `true`.

```typescript
fc.assert(fc.property(
  fc.constantFrom(...IGNORED_FILES),
  fc.array(fc.string({ minLength: 1 }).filter(s => !s.includes("/"))),
  (ignoredFile, dirs) => {
    const path = dirs.length > 0 ? `${dirs.join("/")}/${ignoredFile}` : ignoredFile;
    return shouldIgnorePath(path) === true;
  }
))
```

### Property 3: Extension ignore is total

For any path whose filename ends with an extension in `IGNORED_EXTENSIONS` (single-dot extensions only), `shouldIgnorePath` returns `true`.

```typescript
fc.assert(fc.property(
  fc.constantFrom(...[...IGNORED_EXTENSIONS].filter(e => (e.match(/\./g) || []).length === 1)),
  fc.string({ minLength: 1 }).filter(s => !s.includes("/")),
  (ext, basename) => {
    const path = `src/${basename}${ext}`;
    return shouldIgnorePath(path) === true;
  }
))
```

### Property 4: Compound extension ignore is total

For any filename of the form `<name>.min.js`, `<name>.bundle.js`, `<name>.chunk.js`, or `<name>.min.css`, `shouldIgnorePath` returns `true`.

```typescript
fc.assert(fc.property(
  fc.constantFrom(".min.js", ".bundle.js", ".chunk.js", ".min.css"),
  fc.string({ minLength: 1 }).filter(s => !s.includes(".")),
  (compoundExt, basename) => {
    return shouldIgnorePath(`src/${basename}${compoundExt}`) === true;
  }
))
```

### Property 5: TypeScript declaration files are always ignored

For any path ending in `.d.ts`, `shouldIgnorePath` returns `true`.

```typescript
fc.assert(fc.property(
  fc.string({ minLength: 1 }).filter(s => !s.includes("/")),
  (basename) => {
    return shouldIgnorePath(`src/${basename}.d.ts`) === true;
  }
))
```

### Property 6: Source TypeScript files in src/ are never ignored

For any path of the form `src/<name>.ts` where `<name>` does not contain ignored patterns, `shouldIgnorePath` returns `false`.

```typescript
fc.assert(fc.property(
  fc.string({ minLength: 1 }).filter(s =>
    !s.includes("/") &&
    !s.includes(".") &&
    ![...DEFAULT_IGNORE_LIST].some(seg => s === seg)
  ),
  (name) => {
    return shouldIgnorePath(`src/${name}.ts`) === false;
  }
))
```

### Property 7: shouldIgnorePath is pure (idempotent)

Calling `shouldIgnorePath` twice with the same input always returns the same result.

```typescript
fc.assert(fc.property(
  fc.string(),
  (path) => {
    return shouldIgnorePath(path) === shouldIgnorePath(path);
  }
))
```

### Property 8: Windows path normalization is transparent

For any path, replacing `/` with `\` does not change the result of `shouldIgnorePath`.

```typescript
fc.assert(fc.property(
  fc.string().filter(s => !s.includes("\\")),
  (posixPath) => {
    const windowsPath = posixPath.replace(/\//g, "\\");
    return shouldIgnorePath(posixPath) === shouldIgnorePath(windowsPath);
  }
))
```

### Property 9: Generated file patterns are always ignored

For any path containing `.generated.` in the filename, `shouldIgnorePath` returns `true`.

```typescript
fc.assert(fc.property(
  fc.string({ minLength: 1 }).filter(s => !s.includes("/")),
  fc.string({ minLength: 1 }).filter(s => !s.includes("/")),
  (prefix, suffix) => {
    return shouldIgnorePath(`src/${prefix}.generated.${suffix}`) === true;
  }
))
```
