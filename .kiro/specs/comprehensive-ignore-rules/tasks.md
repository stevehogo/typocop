# Tasks: Comprehensive File Ignore Rules

## Task List

- [x] 1. Audit and patch src/utils/ignore.ts
  _Skills: `typescript-expert`, `clean-code`
  - [x] 1.1 Add `__tests__` to DEFAULT_IGNORE_LIST (missing from current implementation)
  - [x] 1.2 Change `DEFAULT_IGNORE_LIST`, `IGNORED_EXTENSIONS`, `IGNORED_FILES` from `const x = new Set(...)` to `export const x: ReadonlySet<string> = new Set(...)` so callers can inspect the lists
  - [x] 1.3 Verify `shouldIgnorePath` export uses explicit return type annotation (`boolean`)

- [x] 2. Write unit tests — src/utils/ignore.test.ts
  _Skills: `testing-patterns`, `tdd-workflow`
  - [x] 2.1 Test directory segment matching: `node_modules/lodash/index.js` → true
  - [x] 2.2 Test nested segment matching: `src/node_modules/foo.ts` → true
  - [x] 2.3 Test exact filename matching: `package-lock.json` → true, `src/package-lock.json` → true
  - [x] 2.4 Test single extension matching: `assets/logo.png` → true, `dist/app.wasm` → true
  - [x] 2.5 Test compound extension matching: `app.min.js` → true, `vendor.bundle.js` → true, `0.chunk.js` → true, `styles.min.css` → true
  - [x] 2.6 Test generated pattern matching: `src/types/api.d.ts` → true, `src/api.generated.ts` → true
  - [x] 2.7 Test allowed source files: `src/index.ts` → false, `src/utils/ignore.ts` → false, `README.md` → false
  - [x] 2.8 Test Windows path normalization: `node_modules\\lodash\\index.js` → true
  - [x] 2.9 Test case-insensitive filename matching: `PACKAGE-LOCK.JSON` → true (via lowercased check)

- [x] 3. Write property-based tests — src/utils/ignore.test.ts (fast-check)
  _Skills: `testing-patterns`
  - [x] 3.1 Property 1: any path with a DEFAULT_IGNORE_LIST segment → always true
  - [x] 3.2 Property 2: any path with an IGNORED_FILES filename → always true
  - [x] 3.3 Property 3: any path with a single-dot IGNORED_EXTENSIONS extension → always true
  - [x] 3.4 Property 4: compound extensions (.min.js, .bundle.js, .chunk.js, .min.css) → always true
  - [x] 3.5 Property 5: any path ending in .d.ts → always true
  - [x] 3.6 Property 6: src/<clean-name>.ts paths → always false
  - [x] 3.7 Property 7: shouldIgnorePath is pure (same input → same output)
  - [x] 3.8 Property 8: Windows path normalization is transparent (/ vs \\ gives same result)
  - [x] 3.9 Property 9: any path with .generated. in filename → always true

- [x] 4. Verify Phase 1 walker integration — src/indexer/structure/index.ts
  _Skills: `testing-patterns`, `clean-code`
  - [x] 4.1 Confirm `shouldIgnorePath` is called on both directory entries and file entries (current code calls it on `relativePath` before the `isDirectory` branch — verify this covers both cases)
  - [x] 4.2 Add integration smoke test: create a temp fixture with `node_modules/foo.ts`, `src/index.ts`, `logo.png`, `package-lock.json`; assert only `src/index.ts` appears in walkFileTree result

- [x] 5. Run tests and confirm all pass
  - [x] 5.1 Run `pnpm vitest --run src/utils/ignore.test.ts --reporter=basic`
  - [x] 5.2 Run `pnpm vitest --run --reporter=basic` to confirm no regressions
