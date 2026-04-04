// Ported from legacy-parser/parser/ignore-service.ts
// Comprehensive ignore rules for file tree walking

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
  "__mocks__", ".jest",

  // Logs & Temp
  "logs", "log", "tmp", "temp", "cache", ".cache", ".tmp", ".temp",

  // Generated
  ".generated", "generated", "auto-generated", ".terraform",

  // Misc
  ".husky", ".github", ".circleci", ".gitlab",
  "fixtures", "snapshots", "__snapshots__",
]);

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

  // Minified/Bundled
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
]);

const IGNORED_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "composer.lock", "Gemfile.lock", "poetry.lock",
  "Cargo.lock", "go.sum",
  ".gitignore", ".gitattributes",
  ".npmrc", ".yarnrc", ".editorconfig",
  ".prettierrc", ".prettierignore",
  ".eslintignore", ".dockerignore",
  "Thumbs.db", ".DS_Store",
  "LICENSE", "LICENSE.md", "LICENSE.txt",
  "CHANGELOG.md", "CHANGELOG",
  "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "SECURITY.md",
  ".env", ".env.local", ".env.development",
  ".env.production", ".env.test", ".env.example",
]);

/**
 * Returns true if the given file path should be excluded from indexing.
 * Checks directory segments, exact filenames, extensions, and compound extensions.
 */
export const shouldIgnorePath = (filePath: string): boolean => {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const parts = normalizedPath.split("/");
  const fileName = parts[parts.length - 1];
  const fileNameLower = fileName.toLowerCase();

  // Check if any path segment is in the ignore list
  for (const part of parts) {
    if (DEFAULT_IGNORE_LIST.has(part)) return true;
  }

  // Check exact filename matches
  if (IGNORED_FILES.has(fileName) || IGNORED_FILES.has(fileNameLower)) return true;

  // Check extension (and compound extensions like .min.js, .bundle.js)
  const lastDot = fileNameLower.lastIndexOf(".");
  if (lastDot !== -1) {
    const ext = fileNameLower.substring(lastDot);
    if (IGNORED_EXTENSIONS.has(ext)) return true;

    const secondLastDot = fileNameLower.lastIndexOf(".", lastDot - 1);
    if (secondLastDot !== -1) {
      const compoundExt = fileNameLower.substring(secondLastDot);
      if (IGNORED_EXTENSIONS.has(compoundExt)) return true;
    }
  }

  // Skip TypeScript declaration files and generated/bundled code
  if (
    fileNameLower.endsWith(".d.ts") ||
    fileNameLower.includes(".bundle.") ||
    fileNameLower.includes(".chunk.") ||
    fileNameLower.includes(".generated.")
  ) {
    return true;
  }

  return false;
};
