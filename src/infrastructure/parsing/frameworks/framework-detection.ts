/**
 * Wave 6 — framework detection (path + AST).
 *
 * Detects frameworks from
 *   1) file-path patterns (`detectFrameworkFromPath`), and
 *   2) AST definition text — decorators / annotations / attributes
 *      (`detectFrameworkFromAST`),
 * and supplies entry-point multipliers for process scoring.
 *
 * DESIGN: returns `null` for unknown frameworks → callers apply a neutral 1.0
 * multiplier (no bonus, no penalty), so non-framework files see no behaviour
 * change. The cheap path probe + a quick text probe gate the (more expensive)
 * AST framework pass in Phase 2.
 *
 * Provenance: ported from the legacy parser (typocop's pre-refactor parser
 * lineage). Re-keyed from the legacy `SupportedLanguages` enum onto typocop's
 * lowercase {@link Language} union: C# is `csharp` (not the legacy `c_sharp`),
 * and the legacy Kotlin AST block is dropped (typocop's union has no `kotlin`,
 * mirroring the `export-detection.ts` precedent). The Kotlin *path* rules are
 * retained verbatim — they match on literal `.kt` strings, not the union, so
 * they remain harmless dead-by-extension rules.
 */
import type { Language } from "../../../core/domain.js";

export interface FrameworkHint {
  framework: string;
  entryPointMultiplier: number;
  reason: string;
}

// ─── Path-based framework detection ───────────────────────────────────────────

/**
 * Detect a framework from a file path. First match wins — the ordered if-chain
 * is load-bearing (e.g. the Next.js `/pages/` test precedes the Express
 * `/routes/` test). Returns `null` when nothing matches (→ neutral 1.0).
 */
export function detectFrameworkFromPath(filePath: string): FrameworkHint | null {
  // Normalize separators and ensure a leading slash so `/app/` etc. match.
  let p = filePath.toLowerCase().replace(/\\/g, "/");
  if (!p.startsWith("/")) {
    p = "/" + p;
  }

  // ── JavaScript / TypeScript ──
  if (p.includes("/pages/") && !p.includes("/_") && !p.includes("/api/")) {
    if (p.endsWith(".tsx") || p.endsWith(".ts") || p.endsWith(".jsx") || p.endsWith(".js")) {
      return { framework: "nextjs-pages", entryPointMultiplier: 3.0, reason: "nextjs-page" };
    }
  }
  if (
    p.includes("/app/") &&
    (p.endsWith("page.tsx") || p.endsWith("page.ts") || p.endsWith("page.jsx") || p.endsWith("page.js"))
  ) {
    return { framework: "nextjs-app", entryPointMultiplier: 3.0, reason: "nextjs-app-page" };
  }
  if (p.includes("/pages/api/") || (p.includes("/app/") && p.includes("/api/") && p.endsWith("route.ts"))) {
    return { framework: "nextjs-api", entryPointMultiplier: 3.0, reason: "nextjs-api-route" };
  }
  if (p.includes("/app/") && (p.endsWith("layout.tsx") || p.endsWith("layout.ts"))) {
    return { framework: "nextjs-app", entryPointMultiplier: 2.0, reason: "nextjs-layout" };
  }
  if (p.includes("/routes/") && (p.endsWith(".ts") || p.endsWith(".js"))) {
    return { framework: "express", entryPointMultiplier: 2.5, reason: "routes-folder" };
  }
  if (p.includes("/controllers/") && (p.endsWith(".ts") || p.endsWith(".js"))) {
    return { framework: "mvc", entryPointMultiplier: 2.5, reason: "controllers-folder" };
  }
  if (p.includes("/handlers/") && (p.endsWith(".ts") || p.endsWith(".js"))) {
    return { framework: "handlers", entryPointMultiplier: 2.5, reason: "handlers-folder" };
  }
  if ((p.includes("/components/") || p.includes("/views/")) && (p.endsWith(".tsx") || p.endsWith(".jsx"))) {
    const fileName = p.split("/").pop() || "";
    if (/^[A-Z]/.test(fileName)) {
      return { framework: "react", entryPointMultiplier: 1.5, reason: "react-component" };
    }
  }

  // ── Python ──
  if (p.endsWith("views.py")) {
    return { framework: "django", entryPointMultiplier: 3.0, reason: "django-views" };
  }
  if (p.endsWith("urls.py")) {
    return { framework: "django", entryPointMultiplier: 2.0, reason: "django-urls" };
  }
  if ((p.includes("/routers/") || p.includes("/endpoints/") || p.includes("/routes/")) && p.endsWith(".py")) {
    return { framework: "fastapi", entryPointMultiplier: 2.5, reason: "api-routers" };
  }
  if (p.includes("/api/") && p.endsWith(".py") && !p.endsWith("__init__.py")) {
    return { framework: "python-api", entryPointMultiplier: 2.0, reason: "api-folder" };
  }

  // ── Java ──
  if ((p.includes("/controller/") || p.includes("/controllers/")) && p.endsWith(".java")) {
    return { framework: "spring", entryPointMultiplier: 3.0, reason: "spring-controller" };
  }
  if (p.endsWith("controller.java")) {
    return { framework: "spring", entryPointMultiplier: 3.0, reason: "spring-controller-file" };
  }
  if ((p.includes("/service/") || p.includes("/services/")) && p.endsWith(".java")) {
    return { framework: "java-service", entryPointMultiplier: 1.8, reason: "java-service" };
  }

  // ── Kotlin (path rules retained; AST table block dropped — see file header) ──
  if ((p.includes("/controller/") || p.includes("/controllers/")) && p.endsWith(".kt")) {
    return { framework: "spring-kotlin", entryPointMultiplier: 3.0, reason: "spring-kotlin-controller" };
  }
  if (p.endsWith("controller.kt")) {
    return { framework: "spring-kotlin", entryPointMultiplier: 3.0, reason: "spring-kotlin-controller-file" };
  }
  if (p.includes("/routes/") && p.endsWith(".kt")) {
    return { framework: "ktor", entryPointMultiplier: 2.5, reason: "ktor-routes" };
  }
  if (p.includes("/plugins/") && p.endsWith(".kt")) {
    return { framework: "ktor", entryPointMultiplier: 2.0, reason: "ktor-plugin" };
  }
  if (p.endsWith("routing.kt") || p.endsWith("routes.kt")) {
    return { framework: "ktor", entryPointMultiplier: 2.5, reason: "ktor-routing-file" };
  }
  if ((p.includes("/activity/") || p.includes("/ui/")) && p.endsWith(".kt")) {
    return { framework: "android-kotlin", entryPointMultiplier: 2.5, reason: "android-ui" };
  }
  if (p.endsWith("activity.kt") || p.endsWith("fragment.kt")) {
    return { framework: "android-kotlin", entryPointMultiplier: 2.5, reason: "android-component" };
  }
  if (p.endsWith("/main.kt")) {
    return { framework: "kotlin", entryPointMultiplier: 3.0, reason: "kotlin-main" };
  }
  if (p.endsWith("/application.kt")) {
    return { framework: "kotlin", entryPointMultiplier: 2.5, reason: "kotlin-application" };
  }

  // ── C# / .NET ──
  if (p.includes("/controllers/") && p.endsWith(".cs")) {
    return { framework: "aspnet", entryPointMultiplier: 3.0, reason: "aspnet-controller" };
  }
  if (p.endsWith("controller.cs")) {
    return { framework: "aspnet", entryPointMultiplier: 3.0, reason: "aspnet-controller-file" };
  }
  if ((p.includes("/services/") || p.includes("/service/")) && p.endsWith(".cs")) {
    return { framework: "aspnet", entryPointMultiplier: 1.8, reason: "aspnet-service" };
  }
  if (p.includes("/middleware/") && p.endsWith(".cs")) {
    return { framework: "aspnet", entryPointMultiplier: 2.5, reason: "aspnet-middleware" };
  }
  if (p.includes("/hubs/") && p.endsWith(".cs")) {
    return { framework: "signalr", entryPointMultiplier: 2.5, reason: "signalr-hub" };
  }
  if (p.endsWith("hub.cs")) {
    return { framework: "signalr", entryPointMultiplier: 2.5, reason: "signalr-hub-file" };
  }
  if (p.endsWith("/program.cs") || p.endsWith("/startup.cs")) {
    return { framework: "aspnet", entryPointMultiplier: 3.0, reason: "aspnet-entry" };
  }
  if ((p.includes("/backgroundservices/") || p.includes("/hostedservices/")) && p.endsWith(".cs")) {
    return { framework: "aspnet", entryPointMultiplier: 2.0, reason: "aspnet-background-service" };
  }
  if (p.includes("/pages/") && p.endsWith(".razor")) {
    return { framework: "blazor", entryPointMultiplier: 2.5, reason: "blazor-page" };
  }

  // ── Go ──
  if ((p.includes("/handlers/") || p.includes("/handler/")) && p.endsWith(".go")) {
    return { framework: "go-http", entryPointMultiplier: 2.5, reason: "go-handlers" };
  }
  if (p.includes("/routes/") && p.endsWith(".go")) {
    return { framework: "go-http", entryPointMultiplier: 2.5, reason: "go-routes" };
  }
  if (p.includes("/controllers/") && p.endsWith(".go")) {
    return { framework: "go-mvc", entryPointMultiplier: 2.5, reason: "go-controller" };
  }
  // NOTE: the `/cmd/` clause is an unsatisfiable conjunction (a string cannot
  // end with both `/cmd/` and `.go`) — kept verbatim from the legacy source.
  if (p.endsWith("/main.go") || (p.endsWith("/cmd/") && p.endsWith(".go"))) {
    return { framework: "go", entryPointMultiplier: 3.0, reason: "go-main" };
  }

  // ── Rust ──
  if ((p.includes("/handlers/") || p.includes("/routes/")) && p.endsWith(".rs")) {
    return { framework: "rust-web", entryPointMultiplier: 2.5, reason: "rust-handlers" };
  }
  if (p.endsWith("/main.rs")) {
    return { framework: "rust", entryPointMultiplier: 3.0, reason: "rust-main" };
  }
  if (p.includes("/bin/") && p.endsWith(".rs")) {
    return { framework: "rust", entryPointMultiplier: 2.5, reason: "rust-bin" };
  }

  // ── C / C++ ──
  if (p.endsWith("/main.c") || p.endsWith("/main.cpp") || p.endsWith("/main.cc")) {
    return { framework: "c-cpp", entryPointMultiplier: 3.0, reason: "c-main" };
  }
  if (p.includes("/src/") && (p.endsWith("/app.c") || p.endsWith("/app.cpp"))) {
    return { framework: "c-cpp", entryPointMultiplier: 2.5, reason: "c-app" };
  }

  // ── PHP / Laravel ──
  if (p.includes("/routes/") && p.endsWith(".php")) {
    return { framework: "laravel", entryPointMultiplier: 3.0, reason: "laravel-routes" };
  }
  if ((p.includes("/http/controllers/") || p.includes("/controllers/")) && p.endsWith(".php")) {
    return { framework: "laravel", entryPointMultiplier: 3.0, reason: "laravel-controller" };
  }
  if (p.endsWith("controller.php")) {
    return { framework: "laravel", entryPointMultiplier: 3.0, reason: "laravel-controller-file" };
  }
  if ((p.includes("/console/commands/") || p.includes("/commands/")) && p.endsWith(".php")) {
    return { framework: "laravel", entryPointMultiplier: 2.5, reason: "laravel-command" };
  }
  if (p.includes("/jobs/") && p.endsWith(".php")) {
    return { framework: "laravel", entryPointMultiplier: 2.5, reason: "laravel-job" };
  }
  if (p.includes("/listeners/") && p.endsWith(".php")) {
    return { framework: "laravel", entryPointMultiplier: 2.5, reason: "laravel-listener" };
  }
  if (p.includes("/http/middleware/") && p.endsWith(".php")) {
    return { framework: "laravel", entryPointMultiplier: 2.5, reason: "laravel-middleware" };
  }
  if (p.includes("/providers/") && p.endsWith(".php")) {
    return { framework: "laravel", entryPointMultiplier: 1.8, reason: "laravel-provider" };
  }
  if (p.includes("/policies/") && p.endsWith(".php")) {
    return { framework: "laravel", entryPointMultiplier: 2.0, reason: "laravel-policy" };
  }
  if (p.includes("/models/") && p.endsWith(".php")) {
    return { framework: "laravel", entryPointMultiplier: 1.5, reason: "laravel-model" };
  }
  if (p.includes("/services/") && p.endsWith(".php")) {
    return { framework: "laravel", entryPointMultiplier: 1.8, reason: "laravel-service" };
  }
  if (p.includes("/repositories/") && p.endsWith(".php")) {
    return { framework: "laravel", entryPointMultiplier: 1.5, reason: "laravel-repository" };
  }

  // ── Ruby ──
  if ((p.includes("/bin/") || p.includes("/exe/")) && p.endsWith(".rb")) {
    return { framework: "ruby", entryPointMultiplier: 2.5, reason: "ruby-executable" };
  }
  if (p.endsWith("/rakefile") || p.endsWith(".rake")) {
    return { framework: "ruby", entryPointMultiplier: 1.5, reason: "ruby-rake" };
  }

  // ── Swift / iOS ──
  if (p.endsWith("/appdelegate.swift") || p.endsWith("/scenedelegate.swift") || p.endsWith("/app.swift")) {
    return { framework: "ios", entryPointMultiplier: 3.0, reason: "ios-app-entry" };
  }
  if (p.endsWith("app.swift") && p.includes("/sources/")) {
    return { framework: "swiftui", entryPointMultiplier: 3.0, reason: "swiftui-app" };
  }
  if (
    (p.includes("/viewcontrollers/") || p.includes("/controllers/") || p.includes("/screens/")) &&
    p.endsWith(".swift")
  ) {
    return { framework: "uikit", entryPointMultiplier: 2.5, reason: "uikit-viewcontroller" };
  }
  if (p.endsWith("viewcontroller.swift") || p.endsWith("vc.swift")) {
    return { framework: "uikit", entryPointMultiplier: 2.5, reason: "uikit-viewcontroller-file" };
  }
  if (p.includes("/coordinators/") && p.endsWith(".swift")) {
    return { framework: "ios-coordinator", entryPointMultiplier: 2.5, reason: "ios-coordinator" };
  }
  if (p.endsWith("coordinator.swift")) {
    return { framework: "ios-coordinator", entryPointMultiplier: 2.5, reason: "ios-coordinator-file" };
  }
  if ((p.includes("/views/") || p.includes("/scenes/")) && p.endsWith(".swift")) {
    return { framework: "swiftui", entryPointMultiplier: 1.8, reason: "swiftui-view" };
  }
  if (p.includes("/services/") && p.endsWith(".swift")) {
    return { framework: "ios-service", entryPointMultiplier: 1.8, reason: "ios-service" };
  }
  if (p.includes("/router/") && p.endsWith(".swift")) {
    return { framework: "ios-router", entryPointMultiplier: 2.0, reason: "ios-router" };
  }

  // ── Generic ──
  if (
    p.includes("/api/") &&
    (p.endsWith("/index.ts") || p.endsWith("/index.js") || p.endsWith("/__init__.py"))
  ) {
    return { framework: "api", entryPointMultiplier: 1.8, reason: "api-index" };
  }

  return null;
}

// ─── AST-based framework detection ────────────────────────────────────────────

/**
 * Patterns that indicate framework entry points within code definitions.
 * Matched against AST node text (class/method/function declaration text).
 */
export const FRAMEWORK_AST_PATTERNS = {
  nestjs: ["@Controller", "@Get", "@Post", "@Put", "@Delete", "@Patch"],
  express: ["app.get", "app.post", "app.put", "app.delete", "router.get", "router.post"],
  fastapi: ["@app.get", "@app.post", "@app.put", "@app.delete", "@router.get"],
  flask: ["@app.route", "@blueprint.route"],
  spring: ["@RestController", "@Controller", "@GetMapping", "@PostMapping", "@RequestMapping"],
  jaxrs: ["@Path", "@GET", "@POST", "@PUT", "@DELETE"],
  aspnet: [
    "[ApiController]",
    "[HttpGet]",
    "[HttpPost]",
    "[HttpPut]",
    "[HttpDelete]",
    "[Route]",
    "[Authorize]",
    "[AllowAnonymous]",
  ],
  signalr: ["[HubMethodName]", ": Hub", ": Hub<"],
  blazor: ["@page", "[Parameter]", "@inject"],
  efcore: ["DbContext", "DbSet<", "OnModelCreating"],
  "go-http": ["http.Handler", "http.HandlerFunc", "ServeHTTP"],
  laravel: [
    "Route::get",
    "Route::post",
    "Route::put",
    "Route::delete",
    "Route::resource",
    "Route::apiResource",
    "#[Route(",
  ],
  actix: ["#[get", "#[post", "#[put", "#[delete"],
  axum: ["Router::new"],
  rocket: ["#[get", "#[post"],
  uikit: ["viewDidLoad", "viewWillAppear", "viewDidAppear", "UIViewController"],
  swiftui: ["@main", "WindowGroup", "ContentView", "@StateObject", "@ObservedObject"],
  combine: ["sink", "assign", "Publisher", "Subscriber"],
};

interface AstFrameworkPatternConfig {
  framework: string;
  entryPointMultiplier: number;
  reason: string;
  patterns: string[];
}

/**
 * AST framework patterns keyed by typocop's lowercase {@link Language} union.
 * The legacy Kotlin block is dropped (no `kotlin` in the union); C# is keyed as
 * `csharp` (not the legacy `c_sharp`).
 */
const AST_FRAMEWORK_PATTERNS_BY_LANGUAGE: Partial<Record<Language, AstFrameworkPatternConfig[]>> = {
  javascript: [
    { framework: "nestjs", entryPointMultiplier: 3.2, reason: "nestjs-decorator", patterns: FRAMEWORK_AST_PATTERNS.nestjs },
  ],
  typescript: [
    { framework: "nestjs", entryPointMultiplier: 3.2, reason: "nestjs-decorator", patterns: FRAMEWORK_AST_PATTERNS.nestjs },
  ],
  python: [
    { framework: "fastapi", entryPointMultiplier: 3.0, reason: "fastapi-decorator", patterns: FRAMEWORK_AST_PATTERNS.fastapi },
    { framework: "flask", entryPointMultiplier: 2.8, reason: "flask-decorator", patterns: FRAMEWORK_AST_PATTERNS.flask },
  ],
  java: [
    { framework: "spring", entryPointMultiplier: 3.2, reason: "spring-annotation", patterns: FRAMEWORK_AST_PATTERNS.spring },
    { framework: "jaxrs", entryPointMultiplier: 3.0, reason: "jaxrs-annotation", patterns: FRAMEWORK_AST_PATTERNS.jaxrs },
  ],
  csharp: [
    { framework: "aspnet", entryPointMultiplier: 3.2, reason: "aspnet-attribute", patterns: FRAMEWORK_AST_PATTERNS.aspnet },
    { framework: "signalr", entryPointMultiplier: 2.8, reason: "signalr-attribute", patterns: FRAMEWORK_AST_PATTERNS.signalr },
    { framework: "blazor", entryPointMultiplier: 2.5, reason: "blazor-attribute", patterns: FRAMEWORK_AST_PATTERNS.blazor },
    { framework: "efcore", entryPointMultiplier: 2.0, reason: "efcore-pattern", patterns: FRAMEWORK_AST_PATTERNS.efcore },
  ],
  php: [
    { framework: "laravel", entryPointMultiplier: 3.0, reason: "php-route-attribute", patterns: FRAMEWORK_AST_PATTERNS.laravel },
  ],
};

/** Pre-lowercased patterns for O(1) `includes` matching at runtime. */
const AST_PATTERNS_LOWERED: Record<string, AstFrameworkPatternConfig[]> = Object.fromEntries(
  Object.entries(AST_FRAMEWORK_PATTERNS_BY_LANGUAGE).map(([lang, cfgs]) => [
    lang,
    cfgs.map((cfg) => ({ ...cfg, patterns: cfg.patterns.map((pat) => pat.toLowerCase()) })),
  ]),
);

/**
 * Detect a framework from AST definition text (decorators / annotations /
 * attributes). Returns `null` when no known pattern matches.
 *
 * Callers should slice `definitionText` to ~300 chars — annotations sit at the
 * start of a definition, so the head is sufficient and keeps matching cheap.
 */
export function detectFrameworkFromAST(language: Language, definitionText: string): FrameworkHint | null {
  if (!language || !definitionText) return null;

  const configs = AST_PATTERNS_LOWERED[language.toLowerCase()];
  if (!configs || configs.length === 0) return null;

  const normalized = definitionText.toLowerCase();

  for (const cfg of configs) {
    for (const pattern of cfg.patterns) {
      if (normalized.includes(pattern)) {
        return {
          framework: cfg.framework,
          entryPointMultiplier: cfg.entryPointMultiplier,
          reason: cfg.reason,
        };
      }
    }
  }

  return null;
}
