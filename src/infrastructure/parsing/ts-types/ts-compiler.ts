/**
 * Wave 3 Tier A1 — TypeScript compiler-API receiver-type resolution.
 *
 * For TS/JS files this resolves a member call's receiver type from the REAL
 * TypeScript type checker (whole-program), which is strictly more accurate than
 * the Tier-B per-file AST type-env: it sees cross-file types, generics, overload
 * resolution, and stdlib types the AST heuristic cannot.
 *
 * The answer is emitted as the SAME `receiverType` hint field Tier B produces,
 * so Phase 3 consumes it uniformly (no Phase-3 change beyond what Tier B added) —
 * Tier A1 is just a higher-accuracy PRODUCER of `hint.receiverType` that takes
 * PRECEDENCE over the Tier-B env answer.
 *
 * ── LAZY-LOAD CONTRACT (hard requirement) ────────────────────────────────────
 * `typescript` is a ~tens-of-MB module and building a `Program` type-checks the
 * whole repo. It MUST therefore be loaded ONLY when the Tier-A1 flag is on, via
 * the DYNAMIC `await import("typescript")` below — there is no top-level
 * `import ... from "typescript"` anywhere in shipped src. When the flag is off,
 * {@link enrichHintsWithTsTypes} is never called, so this module's `import()` is
 * never reached and the compiler stays unloaded (flag-off is byte-identical and
 * pays zero compiler cost). Mirrors the lazy native-grammar `await import(...)`
 * pattern already used in `parse-file.ts`.
 *
 * ── WHOLE-PROGRAM, NOT PER-FILE ──────────────────────────────────────────────
 * `getTypeAtLocation` for a receiver in file A may resolve to a class declared in
 * file B, so this CANNOT live in the per-file Phase-2 parse path (which also runs
 * in worker threads that cannot share a `Program`). It runs as a post-Phase-2,
 * whole-corpus pass and builds exactly ONE `Program` per project, reused across
 * every call site, then torn down at end of run.
 */
import * as path from "path";
import type { Language } from "../../../core/domain.js";

/**
 * The narrow shape of a relationship hint this pass reads and (conceptually)
 * overrides. Structurally compatible with both `RawRelationshipHint` and the
 * cached mirror — declared locally so this leaf module imports no parsing
 * siblings (depcruise `infra-no-sibling`).
 */
export interface ReceiverTypeHint {
  readonly kind: "import" | "call" | "inherits" | "implements" | "access";
  readonly sourceFile: string;
  readonly targetName: string;
  readonly startLine: number;
  readonly language: Language;
  readonly receiverText?: string;
  readonly receiverType?: string;
}

/**
 * ── A2 SEAM (DEFERRED) ────────────────────────────────────────────────────────
 * The merge interface every Tier-A type source implements. Tier A1 (this file)
 * provides the TypeScript-compiler implementation for `typescript`/`javascript`.
 * Tier A2 (real language servers — pyright for Python, gopls for Go, …) will add
 * sibling implementations behind THIS SAME interface, registered per language and
 * queried identically by {@link enrichHintsWithTsTypes}'s merge loop. A2 does NOT
 * change the consumer or the hint contract — it only adds resolvers for more
 * languages, each opt-in and degrading to Tier B when its server is absent.
 *
 * NO LSP-client dependency is added in A1 — this is purely a documented plug
 * point so A2 slots in without touching the precedence/merge logic.
 */
export interface ReceiverTypeResolver {
  /** Languages this resolver answers for (e.g. `["typescript", "javascript"]`). */
  readonly languages: ReadonlySet<Language>;
  /**
   * Resolve the nominal receiver type NAME for a single member-call hint, or
   * `undefined` on a miss (unresolvable / `any` / non-member call). A miss falls
   * back to the Tier-B answer already on the hint.
   */
  resolveReceiverType(hint: ReceiverTypeHint): string | undefined;
  /** Release any heavyweight resources (the TS `Program`, an LSP process, …). */
  dispose(): void;
}

/** Languages Tier A1 (the TypeScript compiler API) can answer for. */
const TS_LANGUAGES: ReadonlySet<Language> = new Set<Language>([
  "typescript",
  "javascript",
]);

/**
 * tsconfig discovery precedence — mirrors `application/indexing/language-config.ts`
 * (`loadTsconfigPaths`) so A1 picks the SAME root config the import-alias path
 * does. We do NOT reuse that loader (it is a lossy hand-rolled JSON parse that
 * ignores `extends`/`include`); we feed the full set to the real config parser.
 */
const TSCONFIG_CANDIDATES = ["tsconfig.json", "tsconfig.app.json", "tsconfig.base.json"] as const;

/** The subset of the `typescript` module surface this pass touches. */
type TsModule = typeof import("typescript");

/**
 * Build the Tier-A1 TypeScript-compiler resolver for a project rooted at
 * `sourcePath`. Performs the LAZY `import("typescript")`, locates + parses the
 * tsconfig, and builds ONE `Program`/checker reused for every query. Returns
 * `undefined` when no usable TS project can be constructed (no tsconfig + no TS
 * files, or a load failure) — the caller then leaves the Tier-B answer in place.
 *
 * This is the ONLY place `typescript` is imported in shipped src, and it is only
 * reached when the Tier-A1 flag is on.
 */
async function createTsCompilerResolver(
  sourcePath: string,
): Promise<ReceiverTypeResolver | undefined> {
  let ts: TsModule;
  try {
    ts = await import("typescript");
  } catch {
    // typescript not installed at runtime → silently degrade to Tier B.
    return undefined;
  }

  const root = path.resolve(sourcePath);

  // 1. Locate the project's tsconfig (same precedence as the alias path).
  let configPath: string | undefined;
  for (const candidate of TSCONFIG_CANDIDATES) {
    const found = ts.findConfigFile(root, ts.sys.fileExists, candidate);
    if (found !== undefined) {
      configPath = found;
      break;
    }
  }

  // 2. Resolve compiler options + the file set.
  let options: import("typescript").CompilerOptions;
  let rootNames: readonly string[];
  if (configPath !== undefined) {
    // `getParsedCommandLineOfConfigFile` resolves `extends`, `paths`,
    // `include/exclude`, and yields `{ options, fileNames }` — the lossless path.
    const parsed = ts.getParsedCommandLineOfConfigFile(
      configPath,
      /*optionsToExtend*/ undefined,
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: () => {},
      },
    );
    if (parsed === undefined || parsed.fileNames.length === 0) return undefined;
    options = parsed.options;
    rootNames = parsed.fileNames;
  } else {
    // No tsconfig: synthesize permissive options and let the program discover
    // files from whatever the caller's hints reference (it is built lazily on
    // first query against the union of referenced files — see below). With no
    // root config and no seed files we cannot build a program, so bail.
    return undefined;
  }

  // 3. Build ONE Program for the whole project. This is the heavy step
  //    (whole-repo type-check); it happens exactly once and is reused.
  let program: import("typescript").Program | undefined = ts.createProgram({
    rootNames: [...rootNames],
    options,
  });
  let checker: import("typescript").TypeChecker | undefined = program.getTypeChecker();

  /**
   * Map a tree-sitter call hint onto its TS-AST member-call receiver and read the
   * receiver's nominal type name from the checker. Returns `undefined` on any
   * miss (file not in program, no matching call node, `any`/anonymous type).
   */
  const resolveReceiverType = (hint: ReceiverTypeHint): string | undefined => {
    if (program === undefined || checker === undefined) return undefined;
    if (hint.kind !== "call") return undefined;

    // The hint's sourceFile is cwd-relative; the program keys absolute paths.
    const absPath = path.resolve(root, hint.sourceFile);
    const sf =
      program.getSourceFile(absPath) ??
      program.getSourceFile(hint.sourceFile);
    if (sf === undefined) return undefined;

    const target = findMemberCallReceiver(ts, sf, hint);
    if (target === undefined) return undefined;

    const type = checker.getTypeAtLocation(target);
    return nominalTypeName(ts, checker, type);
  };

  return {
    languages: TS_LANGUAGES,
    resolveReceiverType,
    dispose() {
      // Drop the Program so it does not pin the whole-repo type-check across a
      // long-lived `watch` session.
      program = undefined;
      checker = undefined;
    },
  };
}

/**
 * Find the receiver (`expression` of a `PropertyAccessExpression`) of the member
 * call described by `hint`, within source file `sf`. Matches on the hint's
 * 0-indexed line (tree-sitter `startPosition.row` == TS line - 1), the called
 * property name (`hint.targetName`), and — when present — the raw receiver text
 * (`hint.receiverText`). Returns the receiver AST node or `undefined`.
 */
function findMemberCallReceiver(
  ts: TsModule,
  sf: import("typescript").SourceFile,
  hint: ReceiverTypeHint,
): import("typescript").Node | undefined {
  let best: import("typescript").Node | undefined;

  const visit = (node: import("typescript").Node): void => {
    if (best !== undefined) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const propAccess = node.expression;
      // Property name must match the called method.
      if (propAccess.name.text === hint.targetName) {
        // tree-sitter row is 0-indexed; TS lineAndCharacter is 0-indexed too.
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        if (line === hint.startLine) {
          const receiver = propAccess.expression;
          // When the hint carries the raw receiver text, require it to match the
          // receiver expression text (cheap disambiguation when a line has more
          // than one member call). When absent, the line+name match suffices.
          if (
            hint.receiverText === undefined ||
            receiver.getText(sf).trim() === hint.receiverText.trim()
          ) {
            best = receiver;
            return;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return best;
}

/**
 * Reduce a checker type to a single nominal class/interface NAME suitable for
 * `typeNameToSymbol` resolution in Phase 3. Unwraps the common cases the Tier-B
 * `bareTypeName`/`extractReturnTypeName` path handles (so the two tiers agree on
 * shape): a `Promise<User>`-style wrapper is left to the checker's own apparent
 * type; we take the type's symbol name and strip any generic instantiation.
 * Returns `undefined` for anonymous/`any`/primitive types that name no symbol.
 */
function nominalTypeName(
  ts: TsModule,
  checker: import("typescript").TypeChecker,
  type: import("typescript").Type,
): string | undefined {
  // Prefer the declared symbol name (the nominal class/interface), which is what
  // Phase 3's `typeNameToSymbol` keys on.
  const symbol = type.getSymbol() ?? type.aliasSymbol;
  if (symbol !== undefined) {
    const name = symbol.getName();
    if (name && name !== "__type" && name !== "__object" && !isNoiseName(name)) {
      return name;
    }
  }

  // Fall back to the printed type string, stripped of generic args / nullability,
  // when it names a single nominal type (e.g. `User`, `models.User`).
  const printed = checker.typeToString(
    type,
    undefined,
    ts.TypeFormatFlags.NoTruncation,
  );
  return bareNominalFromString(printed);
}

/** Names the checker uses for built-in / structural types we never resolve. */
function isNoiseName(name: string): boolean {
  switch (name) {
    case "any":
    case "unknown":
    case "never":
    case "void":
    case "undefined":
    case "null":
    case "Object":
    case "Function":
      return true;
    default:
      return false;
  }
}

/**
 * Extract a single bare nominal name from a printed type string, or `undefined`.
 * Mirrors the Tier-B normalisation contract: drop a generic wrapper, take the
 * last dotted segment, reject unions/primitives/structural shapes.
 */
function bareNominalFromString(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  // Reject structural/object/function/union/intersection/array printouts.
  if (/[{}()|&\[\]]/.test(text)) return undefined;
  // Strip a single generic wrapper: `List<User>` keeps `List`; the checker has
  // already resolved the receiver to its apparent type, so the base name is what
  // we want for nominal lookup.
  const base = text.replace(/<.*>$/, "");
  // Last dotted segment: `models.User` → `User`.
  const last = base.split(".").pop() ?? base;
  if (!/^[A-Za-z_$][\w$]*$/.test(last)) return undefined;
  if (isNoiseName(last)) return undefined;
  // Lower-case-initial names are primitives/locals by convention, not classes.
  if (!/^[A-Z_$]/.test(last)) return undefined;
  return last;
}

/**
 * Tier-A1 whole-corpus enrichment pass. For each TS/JS `call` hint, ask the
 * TypeScript compiler API for the receiver's nominal type and, on a hit, STAMP it
 * onto `receiverType` with PRECEDENCE over whatever Tier B put there. On a miss
 * (or for non-TS/JS hints, or when no TS project can be built), the hint is left
 * untouched so the Tier-B answer (or `undefined`) survives.
 *
 * Returns a NEW hint array (hints are `readonly`); the input is never mutated, so
 * the per-file parse-cache snapshot (which stores the pre-enrichment hints) is
 * unaffected — A1 re-runs on the merged set every run, which is correct because
 * it is whole-program and cannot be cached per file.
 *
 * @param tier reporting hook (optional) — records which tier answered each hint
 *   for explainability. NOT persisted; in-memory only.
 */
export async function enrichHintsWithTsTypes<T extends ReceiverTypeHint>(
  hints: readonly T[],
  opts: { sourcePath: string; onResolved?: (tier: "A1") => void },
): Promise<T[]> {
  // Only build the (heavy) resolver when there is at least one TS/JS call hint to
  // answer — a pure non-TS corpus pays nothing beyond this scan.
  const hasTsCall = hints.some(
    (h) => h.kind === "call" && TS_LANGUAGES.has(h.language),
  );
  if (!hasTsCall) return [...hints];

  const resolver = await createTsCompilerResolver(opts.sourcePath);
  if (resolver === undefined) return [...hints];

  try {
    return hints.map((hint) => {
      if (hint.kind !== "call" || !resolver.languages.has(hint.language)) {
        return hint;
      }
      const resolved = resolver.resolveReceiverType(hint);
      if (resolved === undefined) return hint;
      opts.onResolved?.("A1");
      // PRECEDENCE: the compiler answer overrides the Tier-B `receiverType`.
      return { ...hint, receiverType: resolved };
    });
  } finally {
    resolver.dispose();
  }
}
