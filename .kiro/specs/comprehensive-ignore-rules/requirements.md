# Requirements: Comprehensive File Ignore Rules

## Overview

Expand `src/utils/ignore.ts` with a complete ignore rule set ported from the legacy parser, and ensure the Phase 1 walker uses it correctly. This prevents lock files, images, `.d.ts` declaration files, and minified bundles from being indexed.

---

## Requirement 1: DEFAULT_IGNORE_LIST Coverage

The module MUST export a `DEFAULT_IGNORE_LIST` constant containing at minimum:
- Version control directories: `.git`, `.svn`, `.hg`, `.bzr`
- IDE directories: `.idea`, `.vscode`, `.vs`, `.eclipse`, `.settings`
- Dependency directories: `node_modules`, `bower_components`, `jspm_packages`, `vendor`, `venv`, `.venv`, `env`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `site-packages`, `.tox`, `eggs`, `.eggs`, `lib64`, `parts`, `sdist`, `wheels`
- Build output directories: `dist`, `build`, `out`, `output`, `bin`, `obj`, `target`, `.next`, `.nuxt`, `.output`, `.vercel`, `.netlify`, `.serverless`, `_build`, `.parcel-cache`, `.turbo`, `.svelte-kit`
- Test/coverage directories: `coverage`, `.nyc_output`, `htmlcov`, `.coverage`, `__tests__`, `__mocks__`, `.jest`
- Temp/cache directories: `logs`, `log`, `tmp`, `temp`, `cache`, `.cache`, `.tmp`, `.temp`
- Generated directories: `.generated`, `generated`, `auto-generated`, `.terraform`
- Misc: `.husky`, `.github`, `.circleci`, `.gitlab`, `fixtures`, `snapshots`, `__snapshots__`

### Acceptance Criteria

1.1 For any file path containing a segment that exactly matches an entry in `DEFAULT_IGNORE_LIST`, `shouldIgnorePath` returns `true`.

1.2 `DEFAULT_IGNORE_LIST` is exported as a `ReadonlySet<string>` (callers cannot mutate it).

1.3 `__tests__` is present in `DEFAULT_IGNORE_LIST` (gap from current implementation).

---

## Requirement 2: IGNORED_EXTENSIONS Coverage

The module MUST export an `IGNORED_EXTENSIONS` constant containing extensions for:
- Images: `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.ico`, `.webp`, `.bmp`, `.tiff`, `.tif`, `.psd`, `.ai`, `.sketch`, `.fig`, `.xd`
- Archives: `.zip`, `.tar`, `.gz`, `.rar`, `.7z`, `.bz2`, `.xz`, `.tgz`
- Binary/compiled: `.exe`, `.dll`, `.so`, `.dylib`, `.a`, `.lib`, `.o`, `.obj`, `.class`, `.jar`, `.war`, `.ear`, `.pyc`, `.pyo`, `.pyd`, `.beam`, `.wasm`, `.node`
- Documents: `.pdf`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`, `.odt`, `.ods`, `.odp`
- Media: `.mp4`, `.mp3`, `.wav`, `.mov`, `.avi`, `.mkv`, `.flv`, `.wmv`, `.ogg`, `.webm`, `.flac`, `.aac`, `.m4a`
- Fonts: `.woff`, `.woff2`, `.ttf`, `.eot`, `.otf`
- Databases: `.db`, `.sqlite`, `.sqlite3`, `.mdb`, `.accdb`
- Compound extensions: `.min.js`, `.min.css`, `.bundle.js`, `.chunk.js`
- Source maps: `.map`
- Lock files: `.lock`
- Certificates/keys: `.pem`, `.key`, `.crt`, `.cer`, `.p12`, `.pfx`
- Data files: `.csv`, `.tsv`, `.parquet`, `.avro`, `.feather`, `.npy`, `.npz`, `.pkl`, `.pickle`, `.h5`, `.hdf5`
- Misc binary: `.bin`, `.dat`, `.data`, `.raw`, `.iso`, `.img`, `.dmg`

### Acceptance Criteria

2.1 For any file path whose extension (last dot to end, lowercased) matches an entry in `IGNORED_EXTENSIONS`, `shouldIgnorePath` returns `true`.

2.2 `IGNORED_EXTENSIONS` is exported as a `ReadonlySet<string>`.

---

## Requirement 3: IGNORED_FILES Coverage

The module MUST export an `IGNORED_FILES` constant containing exact filenames for:
- Lock files: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `composer.lock`, `Gemfile.lock`, `poetry.lock`, `Cargo.lock`, `go.sum`
- VCS config: `.gitignore`, `.gitattributes`
- Tool config: `.npmrc`, `.yarnrc`, `.editorconfig`, `.prettierrc`, `.prettierignore`, `.eslintignore`, `.dockerignore`
- OS artifacts: `Thumbs.db`, `.DS_Store`
- Legal/docs: `LICENSE`, `LICENSE.md`, `LICENSE.txt`, `CHANGELOG.md`, `CHANGELOG`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`
- Environment files: `.env`, `.env.local`, `.env.development`, `.env.production`, `.env.test`, `.env.example`

### Acceptance Criteria

3.1 For any file path whose filename (last segment) exactly matches an entry in `IGNORED_FILES` (case-insensitive), `shouldIgnorePath` returns `true`.

3.2 `IGNORED_FILES` is exported as a `ReadonlySet<string>`.

---

## Requirement 4: Compound Extension Handling

`shouldIgnorePath` MUST detect compound extensions by checking the substring from the second-to-last dot to the end of the filename.

### Acceptance Criteria

4.1 `shouldIgnorePath("dist/app.min.js")` returns `true`.

4.2 `shouldIgnorePath("dist/vendor.bundle.js")` returns `true`.

4.3 `shouldIgnorePath("dist/0.chunk.js")` returns `true`.

4.4 `shouldIgnorePath("dist/styles.min.css")` returns `true`.

4.5 For any filename of the form `<base><compoundExt>` where `compoundExt` is in `IGNORED_EXTENSIONS` and contains two dots, `shouldIgnorePath` returns `true`.

---

## Requirement 5: Generated File Detection

`shouldIgnorePath` MUST detect generated and declaration files by pattern matching on the filename.

### Acceptance Criteria

5.1 Any path ending in `.d.ts` returns `true` (TypeScript declaration files).

5.2 Any path whose filename contains `.generated.` returns `true`.

5.3 Any path whose filename contains `.bundle.` returns `true`.

5.4 Any path whose filename contains `.chunk.` returns `true`.

---

## Requirement 6: Cross-Platform Path Normalization

`shouldIgnorePath` MUST normalize Windows-style backslash separators to forward slashes before processing.

### Acceptance Criteria

6.1 `shouldIgnorePath("node_modules\\lodash\\index.js")` returns `true`.

6.2 For any path, replacing `/` with `\` does not change the return value of `shouldIgnorePath`.

---

## Requirement 7: Pure Function Guarantee

`shouldIgnorePath` MUST be a pure function with no side effects.

### Acceptance Criteria

7.1 Calling `shouldIgnorePath` with the same input twice always returns the same value.

7.2 `shouldIgnorePath` does not modify any module-level state.

7.3 `shouldIgnorePath` does not perform any I/O operations.

---

## Requirement 8: Source Files Are Not Ignored

The ignore rules MUST NOT accidentally exclude valid source files.

### Acceptance Criteria

8.1 `shouldIgnorePath("src/index.ts")` returns `false`.

8.2 `shouldIgnorePath("src/utils/ignore.ts")` returns `false`.

8.3 `shouldIgnorePath("README.md")` returns `false`.

8.4 For any path of the form `src/<name>.ts` where `<name>` contains no ignored directory segments and no ignored filename patterns, `shouldIgnorePath` returns `false`.

---

## Requirement 9: Phase 1 Walker Integration

The `walkFileTree` function in `src/indexer/structure/index.ts` MUST call `shouldIgnorePath` on every file and directory entry before recursing or collecting.

### Acceptance Criteria

9.1 Files under `node_modules/` do not appear in the `FileNode[]` result of `walkFileTree`.

9.2 Files with extensions in `IGNORED_EXTENSIONS` do not appear in the `FileNode[]` result.

9.3 Files matching `IGNORED_FILES` do not appear in the `FileNode[]` result.

9.4 The walker already calls `shouldIgnorePath` — this requirement validates the integration is correct and complete (no bypass paths).

---

## Requirement 10: Test Coverage

A co-located test file `src/utils/ignore.test.ts` MUST exist with unit tests and property-based tests covering all acceptance criteria above.

### Acceptance Criteria

10.1 Unit tests cover each check path: directory segment, exact filename, single extension, compound extension, generated pattern.

10.2 Property-based tests (using `fast-check`) implement the 9 correctness properties defined in `design-correctness.md`.

10.3 Tests verify that common source file paths (`src/index.ts`, `src/utils/ignore.ts`) are not ignored.

10.4 Tests verify Windows path normalization.
