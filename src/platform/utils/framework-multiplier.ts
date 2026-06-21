/**
 * Path-based framework entry-point multipliers (Wave 2, 1.1 — pure data table).
 *
 * Lives in the platform leaf so BOTH `application/querying/framework-layers.ts`
 * and `application/indexing/processes/entry-points.ts` can consume it without
 * crossing the dependency-cruiser `app-no-sibling` boundary. Pure: no imports
 * beyond types, name/path-string matching only (no AST).
 *
 * A path matching a well-known framework convention (e.g. `pages/api/` ×3.0,
 * `/routes/` ×2.5, `/controllers/` ×2.5, `views.py` ×3.0) multiplies a symbol's
 * entry-point score. No match ⇒ `null` (a 1.0 multiplier — no bonus/penalty).
 *
 * Ported from the legacy parser's `detectFrameworkFromPath`. The legacy Kotlin
 * (`.kt`) rules are dropped (typocop's `Language` union has no Kotlin and these
 * never produce a typocop symbol). The order is load-bearing — first match wins.
 */

/** The multiplier + provenance reason for a path-matched framework convention. */
export interface FrameworkMultiplier {
  readonly framework: string;
  readonly multiplier: number;
  readonly reason: string;
}

/**
 * Resolve a path-based framework entry-point multiplier from a file path, or
 * `null` when no convention matches (graceful fallback to a 1.0 multiplier).
 */
export function frameworkEntryPointMultiplier(filePath: string): FrameworkMultiplier | null {
  // Normalize separators + ensure a leading slash so `/app/`-style patterns
  // match a path that starts with `app/...`.
  let p = filePath.toLowerCase().replace(/\\/g, "/");
  if (!p.startsWith("/")) p = "/" + p;

  // ── JavaScript / TypeScript ──────────────────────────────────────────────
  if (p.includes("/pages/") && !p.includes("/_") && !p.includes("/api/")) {
    if (p.endsWith(".tsx") || p.endsWith(".ts") || p.endsWith(".jsx") || p.endsWith(".js")) {
      return { framework: "nextjs-pages", multiplier: 3.0, reason: "nextjs-page" };
    }
  }
  if (p.includes("/app/") && (
    p.endsWith("page.tsx") || p.endsWith("page.ts") ||
    p.endsWith("page.jsx") || p.endsWith("page.js")
  )) {
    return { framework: "nextjs-app", multiplier: 3.0, reason: "nextjs-app-page" };
  }
  if (p.includes("/pages/api/") || (p.includes("/app/") && p.includes("/api/") && p.endsWith("route.ts"))) {
    return { framework: "nextjs-api", multiplier: 3.0, reason: "nextjs-api-route" };
  }
  if (p.includes("/app/") && (p.endsWith("layout.tsx") || p.endsWith("layout.ts"))) {
    return { framework: "nextjs-app", multiplier: 2.0, reason: "nextjs-layout" };
  }
  if (p.includes("/routes/") && (p.endsWith(".ts") || p.endsWith(".js"))) {
    return { framework: "express", multiplier: 2.5, reason: "routes-folder" };
  }
  if (p.includes("/controllers/") && (p.endsWith(".ts") || p.endsWith(".js"))) {
    return { framework: "mvc", multiplier: 2.5, reason: "controllers-folder" };
  }
  if (p.includes("/handlers/") && (p.endsWith(".ts") || p.endsWith(".js"))) {
    return { framework: "handlers", multiplier: 2.5, reason: "handlers-folder" };
  }
  if ((p.includes("/components/") || p.includes("/views/")) &&
      (p.endsWith(".tsx") || p.endsWith(".jsx"))) {
    const fileName = p.split("/").pop() || "";
    if (/^[A-Z]/.test(fileName)) {
      return { framework: "react", multiplier: 1.5, reason: "react-component" };
    }
  }

  // ── Python ───────────────────────────────────────────────────────────────
  if (p.endsWith("views.py")) {
    return { framework: "django", multiplier: 3.0, reason: "django-views" };
  }
  if (p.endsWith("urls.py")) {
    return { framework: "django", multiplier: 2.0, reason: "django-urls" };
  }
  if ((p.includes("/routers/") || p.includes("/endpoints/") || p.includes("/routes/")) &&
      p.endsWith(".py")) {
    return { framework: "fastapi", multiplier: 2.5, reason: "api-routers" };
  }
  if (p.includes("/api/") && p.endsWith(".py") && !p.endsWith("__init__.py")) {
    return { framework: "python-api", multiplier: 2.0, reason: "api-folder" };
  }

  // ── Java ─────────────────────────────────────────────────────────────────
  if ((p.includes("/controller/") || p.includes("/controllers/")) && p.endsWith(".java")) {
    return { framework: "spring", multiplier: 3.0, reason: "spring-controller" };
  }
  if (p.endsWith("controller.java")) {
    return { framework: "spring", multiplier: 3.0, reason: "spring-controller-file" };
  }
  if ((p.includes("/service/") || p.includes("/services/")) && p.endsWith(".java")) {
    return { framework: "java-service", multiplier: 1.8, reason: "java-service" };
  }

  // ── C# / .NET ──────────────────────────────────────────────────────────────
  if (p.includes("/controllers/") && p.endsWith(".cs")) {
    return { framework: "aspnet", multiplier: 3.0, reason: "aspnet-controller" };
  }
  if (p.endsWith("controller.cs")) {
    return { framework: "aspnet", multiplier: 3.0, reason: "aspnet-controller-file" };
  }
  if ((p.includes("/services/") || p.includes("/service/")) && p.endsWith(".cs")) {
    return { framework: "aspnet", multiplier: 1.8, reason: "aspnet-service" };
  }
  if (p.includes("/middleware/") && p.endsWith(".cs")) {
    return { framework: "aspnet", multiplier: 2.5, reason: "aspnet-middleware" };
  }
  if (p.includes("/hubs/") && p.endsWith(".cs")) {
    return { framework: "signalr", multiplier: 2.5, reason: "signalr-hub" };
  }
  if (p.endsWith("hub.cs")) {
    return { framework: "signalr", multiplier: 2.5, reason: "signalr-hub-file" };
  }
  if (p.endsWith("/program.cs") || p.endsWith("/startup.cs")) {
    return { framework: "aspnet", multiplier: 3.0, reason: "aspnet-entry" };
  }
  if ((p.includes("/backgroundservices/") || p.includes("/hostedservices/")) && p.endsWith(".cs")) {
    return { framework: "aspnet", multiplier: 2.0, reason: "aspnet-background-service" };
  }
  if (p.includes("/pages/") && p.endsWith(".razor")) {
    return { framework: "blazor", multiplier: 2.5, reason: "blazor-page" };
  }

  // ── Go ───────────────────────────────────────────────────────────────────
  if ((p.includes("/handlers/") || p.includes("/handler/")) && p.endsWith(".go")) {
    return { framework: "go-http", multiplier: 2.5, reason: "go-handlers" };
  }
  if (p.includes("/routes/") && p.endsWith(".go")) {
    return { framework: "go-http", multiplier: 2.5, reason: "go-routes" };
  }
  if (p.includes("/controllers/") && p.endsWith(".go")) {
    return { framework: "go-mvc", multiplier: 2.5, reason: "go-controller" };
  }
  // NOTE: the `/cmd/` half of this condition can never fire (a path cannot end
  // in both `/cmd/` and `.go`); only `/main.go` triggers. Preserved faithfully
  // from the legacy parser — a Wave 6 fix candidate, not changed here.
  if (p.endsWith("/main.go") || p.endsWith("/cmd/") && p.endsWith(".go")) {
    return { framework: "go", multiplier: 3.0, reason: "go-main" };
  }

  // ── Rust ─────────────────────────────────────────────────────────────────
  if ((p.includes("/handlers/") || p.includes("/routes/")) && p.endsWith(".rs")) {
    return { framework: "rust-web", multiplier: 2.5, reason: "rust-handlers" };
  }
  if (p.endsWith("/main.rs")) {
    return { framework: "rust", multiplier: 3.0, reason: "rust-main" };
  }
  if (p.includes("/bin/") && p.endsWith(".rs")) {
    return { framework: "rust", multiplier: 2.5, reason: "rust-bin" };
  }

  // ── C / C++ ────────────────────────────────────────────────────────────────
  if (p.endsWith("/main.c") || p.endsWith("/main.cpp") || p.endsWith("/main.cc")) {
    return { framework: "c-cpp", multiplier: 3.0, reason: "c-main" };
  }
  if (p.includes("/src/") && (p.endsWith("/app.c") || p.endsWith("/app.cpp"))) {
    return { framework: "c-cpp", multiplier: 2.5, reason: "c-app" };
  }

  // ── PHP / Laravel ──────────────────────────────────────────────────────────
  if (p.includes("/routes/") && p.endsWith(".php")) {
    return { framework: "laravel", multiplier: 3.0, reason: "laravel-routes" };
  }
  if ((p.includes("/http/controllers/") || p.includes("/controllers/")) && p.endsWith(".php")) {
    return { framework: "laravel", multiplier: 3.0, reason: "laravel-controller" };
  }
  if (p.endsWith("controller.php")) {
    return { framework: "laravel", multiplier: 3.0, reason: "laravel-controller-file" };
  }
  if ((p.includes("/console/commands/") || p.includes("/commands/")) && p.endsWith(".php")) {
    return { framework: "laravel", multiplier: 2.5, reason: "laravel-command" };
  }
  if (p.includes("/jobs/") && p.endsWith(".php")) {
    return { framework: "laravel", multiplier: 2.5, reason: "laravel-job" };
  }
  if (p.includes("/listeners/") && p.endsWith(".php")) {
    return { framework: "laravel", multiplier: 2.5, reason: "laravel-listener" };
  }
  if (p.includes("/http/middleware/") && p.endsWith(".php")) {
    return { framework: "laravel", multiplier: 2.5, reason: "laravel-middleware" };
  }
  if (p.includes("/providers/") && p.endsWith(".php")) {
    return { framework: "laravel", multiplier: 1.8, reason: "laravel-provider" };
  }
  if (p.includes("/policies/") && p.endsWith(".php")) {
    return { framework: "laravel", multiplier: 2.0, reason: "laravel-policy" };
  }
  if (p.includes("/models/") && p.endsWith(".php")) {
    return { framework: "laravel", multiplier: 1.5, reason: "laravel-model" };
  }
  if (p.includes("/services/") && p.endsWith(".php")) {
    return { framework: "laravel", multiplier: 1.8, reason: "laravel-service" };
  }
  if (p.includes("/repositories/") && p.endsWith(".php")) {
    return { framework: "laravel", multiplier: 1.5, reason: "laravel-repository" };
  }

  // ── Ruby ─────────────────────────────────────────────────────────────────
  if ((p.includes("/bin/") || p.includes("/exe/")) && p.endsWith(".rb")) {
    return { framework: "ruby", multiplier: 2.5, reason: "ruby-executable" };
  }
  if (p.endsWith("/rakefile") || p.endsWith(".rake")) {
    return { framework: "ruby", multiplier: 1.5, reason: "ruby-rake" };
  }

  // ── Swift / iOS ────────────────────────────────────────────────────────────
  if (p.endsWith("/appdelegate.swift") || p.endsWith("/scenedelegate.swift") || p.endsWith("/app.swift")) {
    return { framework: "ios", multiplier: 3.0, reason: "ios-app-entry" };
  }
  if (p.endsWith("app.swift") && p.includes("/sources/")) {
    return { framework: "swiftui", multiplier: 3.0, reason: "swiftui-app" };
  }
  if ((p.includes("/viewcontrollers/") || p.includes("/controllers/") || p.includes("/screens/")) && p.endsWith(".swift")) {
    return { framework: "uikit", multiplier: 2.5, reason: "uikit-viewcontroller" };
  }
  if (p.endsWith("viewcontroller.swift") || p.endsWith("vc.swift")) {
    return { framework: "uikit", multiplier: 2.5, reason: "uikit-viewcontroller-file" };
  }
  if (p.includes("/coordinators/") && p.endsWith(".swift")) {
    return { framework: "ios-coordinator", multiplier: 2.5, reason: "ios-coordinator" };
  }
  if (p.endsWith("coordinator.swift")) {
    return { framework: "ios-coordinator", multiplier: 2.5, reason: "ios-coordinator-file" };
  }
  if ((p.includes("/views/") || p.includes("/scenes/")) && p.endsWith(".swift")) {
    return { framework: "swiftui", multiplier: 1.8, reason: "swiftui-view" };
  }
  if (p.includes("/services/") && p.endsWith(".swift")) {
    return { framework: "ios-service", multiplier: 1.8, reason: "ios-service" };
  }
  if (p.includes("/router/") && p.endsWith(".swift")) {
    return { framework: "ios-router", multiplier: 2.0, reason: "ios-router" };
  }

  // ── Generic ────────────────────────────────────────────────────────────────
  if (p.includes("/api/") && (
    p.endsWith("/index.ts") || p.endsWith("/index.js") || p.endsWith("/__init__.py")
  )) {
    return { framework: "api", multiplier: 1.8, reason: "api-index" };
  }

  return null;
}
