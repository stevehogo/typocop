# Data Models & Algorithms: Comprehensive File Ignore Rules

Part of the [Comprehensive File Ignore Rules Design](./design.md).

## Core Data Structures

```typescript
// All three sets are exported as ReadonlySet to prevent mutation
export const DEFAULT_IGNORE_LIST: ReadonlySet<string>
export const IGNORED_EXTENSIONS: ReadonlySet<string>
export const IGNORED_FILES: ReadonlySet<string>
```

### DEFAULT_IGNORE_LIST — Directory/Segment Ignores (60+ entries)

Checked against every path segment (not just the filename). A match on any segment causes the entire path to be ignored.

```typescript
const DEFAULT_IGNORE_LIST = new Set([
  // Version Control
  ".git", ".svn", ".hg", ".bzr",

  // IDEs & Editors
  ".idea", ".vscode", ".vs", ".eclipse", ".settings",

  // Dependencies
  "node_modules", "bower_components", "jspm_packages",
  "vendor", "venv", ".venv", "env",
  "__pycache__", ".pytest_cache", ".mypy_cache",
  "site-packages", ".tox", "eggs", ".eggs",
  "lib64", "parts", "sdist", "wheels",

  // Build Outputs
  "dist", "build", "out", "output", "bin", "obj",
  "target", ".next", ".nuxt", ".output",
  ".vercel", ".netlify", ".serverless",
  "_build", ".parcel-cache", ".turbo", ".svelte-kit",

  // Test & Coverage
  "coverage", ".nyc_output", "htmlcov", ".coverage",
  "__tests__", "__mocks__", ".jest",

  // Logs & Temp
  "logs", "log", "tmp", "temp", "cache", ".cache", ".tmp", ".temp",

  // Generated
  ".generated", "generated", "auto-generated", ".terraform",

  // Misc
  ".husky", ".github", ".circleci", ".gitlab",
  "fixtures", "snapshots", "__snapshots__",
])
```

**Gap from legacy**: `__tests__` is present in the legacy but missing from the current implementation. Must be added.

**Note on `public/build`**: The legacy lists `"public/build"` as a single entry. Since `shouldIgnorePath` splits on `/` and checks each segment, this would only match if a segment is literally `"public/build"` — which never happens. The correct handling is to rely on `"build"` already being in the list. No special case needed.

**Note on `.env`**: The legacy lists `.env` in `DEFAULT_IGNORE_LIST` (treating it as a directory name). The current implementation correctly handles `.env` as a file via `IGNORED_FILES`. Both are correct — `.env` as a directory segment is an edge case that doesn't hurt.

### IGNORED_EXTENSIONS — File Extension Ignores (80+ entries)

Checked against the file's extension (last dot to end of filename, lowercased). Also checked as compound extension (second-to-last dot to end).

```typescript
const IGNORED_EXTENSIONS = new Set([
  // Images
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp",
  ".bmp", ".tiff", ".tif", ".psd", ".ai", ".sketch", ".fig", ".xd",

  // Archives
  ".zip", ".tar", ".gz", ".rar", ".7z", ".bz2", ".xz", ".tgz",

  // Binary/Compiled
  ".exe", ".dll", ".so", ".dylib", ".a", ".lib", ".o", ".obj",
  ".class", ".jar", ".war", ".ear",
  ".pyc", ".pyo", ".pyd", ".beam", ".wasm", ".node",

  // Documents
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".odt", ".ods", ".odp",

  // Media
  ".mp4", ".mp3", ".wav", ".mov", ".avi", ".mkv", ".flv", ".wmv",
  ".ogg", ".webm", ".flac", ".aac", ".m4a",

  // Fonts
  ".woff", ".woff2", ".ttf", ".eot", ".otf",

  // Databases
  ".db", ".sqlite", ".sqlite3", ".mdb", ".accdb",

  // Minified/Bundled (compound extensions — also checked via compound logic)
  ".min.js", ".min.css", ".bundle.js", ".chunk.js",

  // Source maps
  ".map",

  // Lock files
  ".lock",

  // Certificates & Keys
  ".pem", ".key", ".crt", ".cer", ".p12", ".pfx",

  // Data files
  ".csv", ".tsv", ".parquet", ".avro", ".feather",
  ".npy", ".npz", ".pkl", ".pickle", ".h5", ".hdf5",

  // Misc binary
  ".bin", ".dat", ".data", ".raw", ".iso", ".img", ".dmg",
])
```

### IGNORED_FILES — Exact Filename Ignores (30+ entries)

Checked against the filename (last path segment), both as-is and lowercased.

```typescript
const IGNORED_FILES = new Set([
  // Lock files
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "composer.lock", "Gemfile.lock", "poetry.lock",
  "Cargo.lock", "go.sum",

  // VCS config
  ".gitignore", ".gitattributes",

  // Tool config (non-code)
  ".npmrc", ".yarnrc", ".editorconfig",
  ".prettierrc", ".prettierignore",
  ".eslintignore", ".dockerignore",

  // OS artifacts
  "Thumbs.db", ".DS_Store",

  // Legal/docs
  "LICENSE", "LICENSE.md", "LICENSE.txt",
  "CHANGELOG.md", "CHANGELOG",
  "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "SECURITY.md",

  // Environment files
  ".env", ".env.local", ".env.development",
  ".env.production", ".env.test", ".env.example",
])
```

## shouldIgnorePath Algorithm

### Function Signature with Formal Specification

```typescript
export function shouldIgnorePath(filePath: string): boolean
```

**Preconditions:**
- `filePath` is a non-empty string
- `filePath` is a relative path (as produced by `path.relative(rootPath, fullPath)`)

**Postconditions:**
- Returns `true` if the path should be excluded from indexing
- Returns `false` if the path should be included
- No side effects — pure function
- Idempotent: `shouldIgnorePath(p) === shouldIgnorePath(p)` for all `p`

**Loop Invariants (segment check loop):**
- All previously checked segments were not in `DEFAULT_IGNORE_LIST`
- The function has not yet returned `true`

### Algorithm

```pascal
FUNCTION shouldIgnorePath(filePath)
  INPUT: filePath: string
  OUTPUT: boolean

  // Step 1: Normalize path separators
  normalizedPath ← filePath.replace(/\\/g, "/")
  parts ← normalizedPath.split("/")
  fileName ← parts[parts.length - 1]
  fileNameLower ← fileName.toLowerCase()

  // Step 2: Check directory segments
  // INVARIANT: all checked parts so far are NOT in DEFAULT_IGNORE_LIST
  FOR each part IN parts DO
    IF DEFAULT_IGNORE_LIST.has(part) THEN
      RETURN true
    END IF
  END FOR

  // Step 3: Check exact filename
  IF IGNORED_FILES.has(fileName) OR IGNORED_FILES.has(fileNameLower) THEN
    RETURN true
  END IF

  // Step 4: Check extension and compound extension
  lastDot ← fileNameLower.lastIndexOf(".")
  IF lastDot ≠ -1 THEN
    ext ← fileNameLower.substring(lastDot)
    IF IGNORED_EXTENSIONS.has(ext) THEN
      RETURN true
    END IF

    secondLastDot ← fileNameLower.lastIndexOf(".", lastDot - 1)
    IF secondLastDot ≠ -1 THEN
      compoundExt ← fileNameLower.substring(secondLastDot)
      IF IGNORED_EXTENSIONS.has(compoundExt) THEN
        RETURN true
      END IF
    END IF
  END IF

  // Step 5: Check generated/bundled patterns
  IF fileNameLower.endsWith(".d.ts")         THEN RETURN true END IF
  IF fileNameLower.includes(".bundle.")      THEN RETURN true END IF
  IF fileNameLower.includes(".chunk.")       THEN RETURN true END IF
  IF fileNameLower.includes(".generated.")   THEN RETURN true END IF

  RETURN false
END FUNCTION
```

**Postcondition verification:**
- Step 2 ensures any ignored directory in the path causes early return
- Step 3 ensures exact filename matches are caught regardless of extension
- Step 4 handles both simple (`.png`) and compound (`.min.js`) extensions
- Step 5 catches patterns not expressible as simple extensions

## Key Functions with Formal Specifications

### isDirectoryIgnored (internal concept)

The segment loop in Step 2 implements this check inline. For a path like `node_modules/lodash/index.js`, the segment `node_modules` matches `DEFAULT_IGNORE_LIST` and the function returns `true` immediately without checking the filename or extension.

**Precondition**: `parts` is a non-empty array of path segments  
**Postcondition**: Returns `true` iff any element of `parts` is in `DEFAULT_IGNORE_LIST`

### isCompoundExtensionIgnored (internal concept)

For a filename like `app.min.js`:
- `lastDot` = index of last `.` → ext = `.js` (not in set)
- `secondLastDot` = index of second-to-last `.` → compoundExt = `.min.js` (in set → return true)

**Precondition**: `fileNameLower` contains at least two `.` characters  
**Postcondition**: Returns `true` iff `fileNameLower.substring(secondLastDot)` is in `IGNORED_EXTENSIONS`

## Example Usage

```typescript
import { shouldIgnorePath, DEFAULT_IGNORE_LIST, IGNORED_EXTENSIONS, IGNORED_FILES } from "./ignore.js";

// Directory segment match
shouldIgnorePath("node_modules/lodash/index.js")  // → true
shouldIgnorePath("src/node_modules/foo.ts")        // → true (segment match)

// Exact filename match
shouldIgnorePath("package-lock.json")              // → true
shouldIgnorePath("src/package-lock.json")          // → true

// Extension match
shouldIgnorePath("assets/logo.png")                // → true
shouldIgnorePath("dist/app.wasm")                  // → true

// Compound extension match
shouldIgnorePath("dist/app.min.js")                // → true
shouldIgnorePath("dist/vendor.bundle.js")          // → true

// Generated pattern match
shouldIgnorePath("src/types/api.d.ts")             // → true
shouldIgnorePath("src/generated.service.ts")       // → false (no .generated. in middle)
shouldIgnorePath("src/api.generated.ts")           // → true (.generated. present)

// Allowed source files
shouldIgnorePath("src/index.ts")                   // → false
shouldIgnorePath("src/utils/ignore.ts")            // → false
shouldIgnorePath("README.md")                      // → false

// Windows path normalization
shouldIgnorePath("node_modules\\lodash\\index.js") // → true
```
