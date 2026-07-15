/**
 * Entry-point NAME heuristics + path predicates (pure, core-only).
 *
 * Lives in the platform leaf so it can be shared across application sub-layers
 * without crossing the dependency-cruiser `app-no-sibling` boundary:
 *   - indexing/processes/entry-points.ts (entry-point SCORING) re-exports these.
 *   - querying/dead-code.ts (D6) reuses them to exclude framework/runtime-
 *     invoked symbols from the dead-code candidate list.
 *
 * Wave 2 (1.1) replaces the single flat 12-pattern array with a LANGUAGE-KEYED
 * table (`ENTRY_POINT_PATTERNS_BY_LANGUAGE`) plus a `'*'` universal bucket and a
 * pre-merged lookup (`MERGED_ENTRY_POINT_PATTERNS`), and adds test/utility-file
 * predicates + an entry-point KIND classifier. The flat `ENTRY_POINT_PATTERNS`
 * export is RETAINED (= the universal bucket) for back-compat of importers that
 * expect a flat array. Ported/re-keyed from the legacy parser's
 * `entry-point-scoring.ts` (its `SupportedLanguages` enum → typocop's lowercase
 * `Language` union; its Kotlin patterns dropped — typocop's union has no Kotlin).
 *
 * Pure data tables + predicates only — NO scoring logic lives here.
 */
import type { Language, EntryPointKind } from "../../core/domain.js";

// ── Language-keyed entry-point name patterns ───────────────────────────────

/**
 * Universal entry-point name patterns (apply to every language). RETAINED as the
 * back-compat flat `ENTRY_POINT_PATTERNS` export.
 */
const UNIVERSAL_PATTERNS: RegExp[] = [
  /^(main|init|bootstrap|start|run|setup|configure)$/i,
  /^handle[A-Z]/,
  /^on[A-Z]/,
  /Handler$/,
  /Controller$/,
  /^process[A-Z]/,
  /^execute[A-Z]/,
  /^perform[A-Z]/,
  /^dispatch[A-Z]/,
  /^trigger[A-Z]/,
  /^fire[A-Z]/,
  /^emit[A-Z]/,
];

/**
 * Back-compat flat export: the universal pattern bucket. Importers that expect a
 * flat `RegExp[]` (e.g. older call sites) keep working unchanged.
 */
export const ENTRY_POINT_PATTERNS: RegExp[] = UNIVERSAL_PATTERNS;

/** Per-language entry-point name patterns (merged with the universal bucket below). */
export const ENTRY_POINT_PATTERNS_BY_LANGUAGE = {
  javascript: [
    /^use[A-Z]/, // React hooks (useEffect, etc.)
  ],
  typescript: [
    /^use[A-Z]/, // React hooks
  ],
  python: [
    /^app$/, // Flask/FastAPI app
    /^(get|post|put|delete|patch)_/i, // REST conventions
    /^api_/,
    /^view_/, // Django views
  ],
  java: [
    /^do[A-Z]/, // doGet, doPost (Servlets)
    /^create[A-Z]/, // Factory patterns
    /^build[A-Z]/, // Builder patterns
    /Service$/,
  ],
  csharp: [
    /^(Get|Post|Put|Delete|Patch)/, // ASP.NET action methods
    /Action$/, // MVC actions
    /^On[A-Z]/, // Event handlers / Blazor lifecycle
    /Async$/, // Async entry points
    /^Configure$/, // Startup.Configure
    /^ConfigureServices$/, // Startup.ConfigureServices
    /^Handle$/, // MediatR / generic handler
    /^Execute$/, // Command pattern
    /^Invoke$/, // Middleware Invoke
    /^Map[A-Z]/, // Minimal API MapGet, MapPost
    /Service$/,
    /^Seed/, // Database seeding
  ],
  go: [
    /Handler$/, // http.Handler pattern
    /^Serve/, // ServeHTTP
    /^New[A-Z]/, // Constructor pattern
    /^Make[A-Z]/, // Make functions
  ],
  rust: [
    /^(get|post|put|delete)_handler$/i,
    /^handle_/, // handle_request
    /^new$/, // Constructor pattern
    /^run$/, // run entry point
    /^spawn/, // Async spawn
  ],
  c: [
    /^main$/, // THE entry point
    /^init_/, /_init$/,
    /^start_/, /_start$/,
    /^run_/, /_run$/,
    /^stop_/, /_stop$/,
    /^open_/, /_open$/,
    /^close_/, /_close$/,
    /^create_/, /_create$/,
    /^destroy_/, /_destroy$/,
    /^handle_/, /_handler$/, /_callback$/,
    /^cmd_/, /^server_/, /^client_/, /^session_/,
    /^window_/, /^key_/, /^input_/, /^output_/,
    /^notify_/, /^control_/,
  ],
  cpp: [
    /^main$/, // THE entry point
    /^init_/, /_init$/,
    /^Create[A-Z]/, // Factory patterns
    /^create_/,
    /^Run$/, /^run$/,
    /^Start$/, /^start$/,
    /^handle_/, /_handler$/, /_callback$/,
    /^OnEvent/, /^on_/,
    /::Run$/, /::Start$/, /::Init$/, /::Execute$/,
  ],
  swift: [
    /^viewDidLoad$/,
    /^viewWillAppear$/,
    /^viewDidAppear$/,
    /^viewWillDisappear$/,
    /^viewDidDisappear$/,
    /^application\(/, // AppDelegate methods
    /^scene\(/, // SceneDelegate methods
    /^body$/, // SwiftUI View.body
    /Coordinator$/,
    /^sceneDidBecomeActive$/,
    /^sceneWillResignActive$/,
    /^didFinishLaunchingWithOptions$/,
    /ViewController$/,
    /^configure[A-Z]/,
    /^setup[A-Z]/,
    /^makeBody$/, // SwiftUI ViewModifier
  ],
  php: [
    /Controller$/,
    /^handle$/, // Job::handle(), Listener::handle()
    /^execute$/, // Command::execute()
    /^boot$/, // ServiceProvider::boot()
    /^register$/, // ServiceProvider::register()
    /^__invoke$/, // Invokable controllers/actions
    /^(index|show|store|update|destroy|create|edit)$/, // RESTful resource methods
    /^(get|post|put|delete|patch)[A-Z]/, // Explicit HTTP method actions
    /^run$/,
    /^fire$/,
    /^dispatch$/,
    /Service$/,
    /Repository$/,
    /^find$/,
    /^findAll$/,
    /^save$/,
    /^delete$/,
  ],
  ruby: [
    /^call$/, // Service objects (MyService.call)
    /^perform$/, // Background jobs (Sidekiq, ActiveJob)
    /^execute$/, // Command pattern
  ],
} satisfies Record<Language, RegExp[]>;

/**
 * Pre-computed merged patterns (universal + language-specific), built once at
 * module load to avoid per-call array allocation. Keyed by `Language`.
 */
export const MERGED_ENTRY_POINT_PATTERNS: Record<Language, RegExp[]> = (() => {
  const out = {} as Record<Language, RegExp[]>;
  for (const [lang, patterns] of Object.entries(ENTRY_POINT_PATTERNS_BY_LANGUAGE)) {
    out[lang as Language] = [...UNIVERSAL_PATTERNS, ...patterns];
  }
  return out;
})();

/**
 * Universal + ALL-language patterns merged once, for the no-language overload of
 * {@link isEntryPointName} (back-compat: a call site that lacks a language still
 * matches against the broadest set).
 */
const MERGED_ALL_PATTERNS: RegExp[] = [
  ...UNIVERSAL_PATTERNS,
  ...Object.values(ENTRY_POINT_PATTERNS_BY_LANGUAGE).flat(),
];

/**
 * True when a symbol name matches an entry-point naming pattern.
 *
 * When `language` is omitted, matches against the merged universal + ALL-language
 * set (back-compat: existing callers like `dead-code.ts` keep working). When
 * supplied, matches the merged universal + per-language set.
 */
export function isEntryPointName(name: string, language?: Language): boolean {
  const patterns = language ? MERGED_ENTRY_POINT_PATTERNS[language] : MERGED_ALL_PATTERNS;
  return patterns.some((p) => p.test(name));
}

// ── Utility (negative) patterns — single shared source ─────────────────────

/**
 * Patterns indicating utility/helper functions (NOT entry points). Penalized in
 * scoring. Consolidated here (was duplicated in `entry-points.ts`) so the
 * negative-pattern set has a single source of truth.
 */
export const UTILITY_PATTERNS: RegExp[] = [
  /^(get|set|is|has|can|should|will|did)[A-Z]/, // Accessors/predicates
  /^_/, // Private by convention
  /^(format|parse|validate|convert|transform)/i, // Transformation utilities
  /^(log|debug|error|warn|info)$/i, // Logging
  /^(to|from)[A-Z]/, // Conversions
  /^(encode|decode)/i,
  /^(serialize|deserialize)/i,
  /^(clone|copy|deep)/i,
  /^(merge|extend|assign)/i,
  /^(filter|map|reduce|sort|find)/i, // Collection utilities
  /Helper$/,
  /Util$/,
  /Utils$/,
  /^utils?$/i,
  /^helpers?$/i,
];

/** True when a symbol name matches a utility/helper pattern (scoring penalty). */
export function isUtilityName(name: string): boolean {
  return UTILITY_PATTERNS.some((p) => p.test(name));
}

// ── Path predicates ─────────────────────────────────────────────────────────

/**
 * True when a file path is a TEST file (excluded from entry-point candidacy).
 * Covers common test-file conventions across the supported languages.
 */
export function isTestFile(filePath: string): boolean {
  const p = filePath.toLowerCase().replace(/\\/g, "/");
  return (
    // JavaScript/TypeScript
    p.includes(".test.") ||
    p.includes(".spec.") ||
    p.includes("__tests__/") ||
    p.includes("__mocks__/") ||
    // Generic test folders
    p.includes("/test/") ||
    p.includes("/tests/") ||
    p.includes("/testing/") ||
    // Python
    p.endsWith("_test.py") ||
    p.includes("/test_") ||
    // Go
    p.endsWith("_test.go") ||
    // Java
    p.includes("/src/test/") ||
    // Swift/iOS
    p.endsWith("tests.swift") ||
    p.endsWith("test.swift") ||
    p.includes("uitests/") ||
    // C#
    p.endsWith("tests.cs") ||
    p.endsWith("test.cs") ||
    p.includes(".tests/") ||
    p.includes(".test/") ||
    p.includes(".integrationtests/") ||
    p.includes(".unittests/") ||
    p.includes("/testproject/") ||
    // PHP/Laravel
    p.endsWith("test.php") ||
    p.endsWith("spec.php") ||
    p.includes("/tests/feature/") ||
    p.includes("/tests/unit/") ||
    // Ruby
    p.endsWith("_spec.rb") ||
    p.endsWith("_test.rb") ||
    p.includes("/spec/") ||
    p.includes("/test/fixtures/")
  );
}

/**
 * True when a file path is likely a utility/helper file. Such files may still
 * have entry points but are de-prioritised (a small scoring penalty, not a hard
 * skip).
 */
export function isUtilityFile(filePath: string): boolean {
  const p = filePath.toLowerCase().replace(/\\/g, "/");
  return (
    p.includes("/utils/") ||
    p.includes("/util/") ||
    p.includes("/helpers/") ||
    p.includes("/helper/") ||
    p.includes("/common/") ||
    p.includes("/shared/") ||
    p.includes("/lib/") ||
    p.endsWith("/utils.ts") ||
    p.endsWith("/utils.js") ||
    p.endsWith("/helpers.ts") ||
    p.endsWith("/helpers.js") ||
    p.endsWith("_utils.py") ||
    p.endsWith("_helpers.py")
  );
}

// ── Entry-point kind classification ──────────────────────────────────────────

/**
 * Classify an entry point from its name, file path, and scoring reasons. Order
 * matters (first match wins). Pure — used only as additive explainability
 * metadata; never affects the numeric score/threshold.
 */
export function inferEntryPointKind(
  name: string,
  filePath: string,
  reasons: readonly string[],
): EntryPointKind {
  const lowerName = name.toLowerCase();
  const lowerPath = filePath.toLowerCase().replace(/\\/g, "/");
  const reasonStr = reasons.join(" ");

  // Test
  if (/^(test_|it_|describe_|spec_)/i.test(name) || /\b(test|spec)\b/i.test(reasonStr)) return "test";
  if (isTestFile(filePath)) return "test";

  // Route / handler
  if (reasonStr.includes("route") || reasonStr.includes("controller") || reasonStr.includes("endpoint"))
    return "route";
  if (/Handler$|Controller$|^(get|post|put|delete|patch)[A-Z]/i.test(name)) return "route";
  if (lowerPath.includes("/routes/") || lowerPath.includes("/controllers/") || lowerPath.includes("pages/api/"))
    return "route";

  // Task / job
  if (/^(perform|execute|dispatch|fire)$/i.test(lowerName) || reasonStr.includes("task") || reasonStr.includes("job"))
    return "task";
  if (lowerPath.includes("/jobs/") || lowerPath.includes("/tasks/") || lowerPath.includes("/commands/"))
    return "task";

  // Event
  if (/^(on[A-Z]|emit[A-Z]|fire[A-Z]|handle[A-Z])/.test(name) && !/(Handler$|Controller$)/.test(name))
    return "event";
  if (lowerPath.includes("/listeners/") || lowerPath.includes("/events/") || lowerPath.includes("/subscribers/"))
    return "event";

  // Lifecycle (framework-specific)
  if (/^(viewDidLoad|viewWillAppear|componentDidMount|ngOnInit|boot|register|configure)$/i.test(name))
    return "lifecycle";

  // Default
  return "main";
}
