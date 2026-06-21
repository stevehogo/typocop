/**
 * Import-resolution sub-pass (Wave 1).
 *
 * Ported from grapuco-cli `import-processor.ts` `processImportsFromExtracted` +
 * `applyImportResult` — the "fast path" that resolves PRE-EXTRACTED imports
 * without re-parsing, which is exactly typocop's hint-driven shape.
 *
 * What it does: given the `import` hints, the repo file list, and the loaded
 * language configs, it resolves each import specifier to file(s)/a package via
 * the per-language dispatch and POPULATES the three resolution maps
 * (`importMap` / `packageMap` / `namedImportMap`) on the live
 * `ResolutionContext`. The existing hint loop in `resolveHints` then reads those
 * maps through `ctx.resolve`, activating Tiers 2a / 2a-named / 2b.
 *
 * What it does NOT do: emit graph edges. grapuco's `applyImportResult` also
 * called `graph.addRelationship` for `IMPORTS`; typocop emits `imports`/`calls`
 * edges in the existing hint loop, so that half is intentionally DROPPED here.
 * This keeps map population separate from edge emission (additive + gateable).
 *
 * ── Go package both-maps decision (plan §Task 4) ──────────────────────────────
 * A `{ kind: "package" }` result writes BOTH: the `dirSuffix` into `packageMap`
 * (Tier 2b) AND every resolved member file into `importMap` (Tier 2a). Tier 2a
 * runs BEFORE Tier 2b in `resolveUncached`, so the exact member files win first;
 * `packageMap` is a backstop (it also covers a repo top-level Go package, where
 * `isFileInPackageDir`'s slash-boundary rule cannot match the bare package
 * path). Both tiers emit the same `"import-scoped"` confidence, so writing both
 * never changes confidence — only widens which planted name resolves.
 */
import type { Language } from "../../../core/domain.js";
import type { LanguageConfigs } from "../language-config.js";
import type { ResolutionContext } from "./resolution-context.js";
import {
  buildImportResolutionContext,
  resolveImportSpecifier,
  type ImportResolutionContext,
  type ResolveCtx,
} from "./import-resolvers/dispatch.js";

/** The subset of `RawRelationshipHint` (kind === "import") this pass consumes. */
export interface ImportHintLike {
  readonly kind: string;
  readonly sourceFile: string;
  /** The module specifier (for imports). */
  readonly targetName: string;
  readonly language: Language;
  /** Named bindings (`import { User as U }`) — populated by Phase 2 for imports. */
  readonly namedBindings?: readonly { local: string; exported: string }[];
}

/**
 * Resolve every import hint's specifier against the repo file list and populate
 * `ctx.importMap` / `ctx.packageMap` / `ctx.namedImportMap`.
 *
 * Rollback lever: callers pass `allFiles` only when import-graph resolution is
 * wanted. With no files there is nothing to resolve against, so this returns
 * early and the maps stay empty → pre-wave Tier-1/3 behaviour.
 */
export function populateImportMaps(
  ctx: ResolutionContext,
  importHints: readonly ImportHintLike[],
  allFiles: readonly string[],
  configs: LanguageConfigs,
  prebuiltCtx?: ImportResolutionContext,
): void {
  if (allFiles.length === 0 || importHints.length === 0) return;

  // Path-convention guard (plan §8 risk): a sampled hint's sourceFile must be
  // present in the file set, or the maps would silently end up empty (abs vs rel
  // mismatch). Fail loud under test, warn in prod.
  assertPathConvention(importHints, allFiles);

  const importCtx = prebuiltCtx ?? buildImportResolutionContext(allFiles);
  const { allFilePaths, allFileList, normalizedFileList, suffixIndex: index, resolveCache } = importCtx;
  const resolveCtx: ResolveCtx = {
    allFilePaths,
    allFileList,
    normalizedFileList,
    index,
    resolveCache,
  };

  const { importMap, packageMap, namedImportMap } = ctx;

  // Group import hints by source file, deduping repeated specifiers per file
  // (the same module imported twice need only resolve once — matches the
  // `importOrdinals` dedupe in the hint loop). Bindings accumulate across the
  // (deduped) occurrences of a specifier.
  const byFile = new Map<string, Map<string, { local: string; exported: string }[]>>();
  for (const hint of importHints) {
    if (hint.kind !== "import") continue;
    let specMap = byFile.get(hint.sourceFile);
    if (!specMap) {
      specMap = new Map();
      byFile.set(hint.sourceFile, specMap);
    }
    const existing = specMap.get(hint.targetName);
    const bindings = hint.namedBindings ? [...hint.namedBindings] : undefined;
    if (!existing) {
      specMap.set(hint.targetName, bindings ? [...bindings] : []);
    } else if (bindings) {
      existing.push(...bindings);
    }
  }

  // Hints carry their own per-hint language, but they were grouped by file; a
  // file is single-language, so recover the language from the first hint of the
  // file. Build a quick filePath → language lookup from the hints.
  const langByFile = new Map<string, Language>();
  for (const hint of importHints) {
    if (hint.kind !== "import") continue;
    if (!langByFile.has(hint.sourceFile)) langByFile.set(hint.sourceFile, hint.language);
  }

  for (const [filePath, specMap] of byFile) {
    const language = langByFile.get(filePath);
    if (!language) continue;

    for (const [specifier, bindings] of specMap) {
      const result = resolveImportSpecifier(filePath, specifier, language, configs, resolveCtx);
      if (!result) continue;

      // Member files → importMap (Tier 2a). Applies to BOTH 'files' and
      // 'package' results (the Go both-maps decision).
      let importSet = importMap.get(filePath);
      if (!importSet) {
        importSet = new Set<string>();
        importMap.set(filePath, importSet);
      }
      for (const resolvedFile of result.files) importSet.add(resolvedFile);

      // Package suffix → packageMap (Tier 2b).
      if (result.kind === "package") {
        let pkgSet = packageMap.get(filePath);
        if (!pkgSet) {
          pkgSet = new Set<string>();
          packageMap.set(filePath, pkgSet);
        }
        pkgSet.add(result.dirSuffix);
      }

      // Named bindings → namedImportMap (Tier 2a-named), ONLY when the specifier
      // resolved to exactly ONE file (a multi-file resolve can't attribute a
      // local name to a single source — matches grapuco's guard).
      if (bindings.length > 0 && result.files.length === 1) {
        const resolvedFile = result.files[0];
        let fileBindings = namedImportMap.get(filePath);
        if (!fileBindings) {
          fileBindings = new Map();
          namedImportMap.set(filePath, fileBindings);
        }
        for (const binding of bindings) {
          fileBindings.set(binding.local, {
            sourcePath: resolvedFile,
            exportedName: binding.exported,
          });
        }
      }
    }
  }
}

/**
 * Assert the threaded `allFiles` use the same path form as hint `sourceFile`s.
 * A mismatch (absolute vs relative) silently empties the maps. Samples up to the
 * first 20 distinct import-hint source files; if NONE are present in the file
 * set, throws (tests) / warns (prod). A partial overlap is fine (some files may
 * have no symbols/hints).
 */
function assertPathConvention(
  importHints: readonly ImportHintLike[],
  allFiles: readonly string[],
): void {
  const fileSet = new Set(allFiles);
  const sampled = new Set<string>();
  for (const hint of importHints) {
    if (hint.kind !== "import") continue;
    sampled.add(hint.sourceFile);
    if (sampled.size >= 20) break;
  }
  if (sampled.size === 0) return;

  let anyPresent = false;
  for (const f of sampled) {
    if (fileSet.has(f)) {
      anyPresent = true;
      break;
    }
  }
  if (anyPresent) return;

  const msg =
    "[import-resolution-pass] Path-convention mismatch: no sampled import-hint " +
    "sourceFile is present in the threaded file list. Import maps would be empty " +
    "(abs-vs-rel path mismatch?). " +
    `Sample hint sourceFile: ${[...sampled][0]}; sample file: ${allFiles[0]}`;
  // Loud in tests, non-fatal in prod (the maps simply stay empty → Tier 1/3).
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    throw new Error(msg);
  }
  console.warn(msg);
}
