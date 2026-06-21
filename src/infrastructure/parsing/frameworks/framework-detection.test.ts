/**
 * Wave 6 — framework-detection unit tests.
 *
 * Covers `detectFrameworkFromAST` (nestjs / laravel / unknown) and
 * `detectFrameworkFromPath`, plus the deliberate re-key/drop decisions:
 *   - C# is keyed as `csharp` (NOT the legacy `c_sharp`).
 *   - there is no Kotlin AST table block (typocop's `Language` union has no
 *     `kotlin`), while the Kotlin *path* rules survive.
 */
import { describe, it, expect } from "vitest";
import {
  detectFrameworkFromAST,
  detectFrameworkFromPath,
} from "./framework-detection.js";

describe("detectFrameworkFromAST", () => {
  it("detects NestJS from a @Controller decorator (typescript)", () => {
    const hint = detectFrameworkFromAST("typescript", "@Controller('users') export class UserController {}");
    expect(hint?.framework).toBe("nestjs");
    expect(hint?.reason).toBe("nestjs-decorator");
  });

  it("detects NestJS from a @Get decorator (javascript)", () => {
    const hint = detectFrameworkFromAST("javascript", "@Get(':id') findOne() {}");
    expect(hint?.framework).toBe("nestjs");
  });

  it("detects Laravel from a #[Route( attribute (php)", () => {
    const hint = detectFrameworkFromAST("php", "#[Route('/users', methods: ['GET'])]");
    expect(hint?.framework).toBe("laravel");
    expect(hint?.reason).toBe("php-route-attribute");
  });

  it("detects ASP.NET under the re-keyed `csharp` (not legacy `c_sharp`)", () => {
    const hint = detectFrameworkFromAST("csharp", "[ApiController] public class UsersController {}");
    expect(hint?.framework).toBe("aspnet");
  });

  it("returns null for unknown / non-framework text", () => {
    expect(detectFrameworkFromAST("typescript", "export function add(a, b) { return a + b; }")).toBeNull();
  });

  it("returns null for empty text and for languages with no AST table", () => {
    expect(detectFrameworkFromAST("typescript", "")).toBeNull();
    // Go/Rust/etc. have no AST framework table → null.
    expect(detectFrameworkFromAST("go", "func main() {}")).toBeNull();
  });

  it("matches case-insensitively", () => {
    expect(detectFrameworkFromAST("typescript", "@CONTROLLER('x')")?.framework).toBe("nestjs");
  });
});

describe("detectFrameworkFromPath", () => {
  it("detects Laravel from a Http/Controllers path", () => {
    const hint = detectFrameworkFromPath("app/Http/Controllers/UserController.php");
    expect(hint?.framework).toBe("laravel");
  });

  it("detects Laravel from a routes/ php file", () => {
    expect(detectFrameworkFromPath("routes/api.php")?.framework).toBe("laravel");
  });

  it("detects NestJS-shaped TS controllers via the mvc/controllers folder rule", () => {
    // `/controllers/` + `.ts` → mvc (the generic MVC rule), not a path miss.
    expect(detectFrameworkFromPath("src/controllers/user.ts")?.framework).toBe("mvc");
  });

  it("retains Kotlin PATH rules even though the AST table block was dropped", () => {
    expect(detectFrameworkFromPath("app/controller/UserController.kt")?.framework).toBe("spring-kotlin");
  });

  it("returns null for a non-framework path", () => {
    expect(detectFrameworkFromPath("src/lib/math-utils.ts")).toBeNull();
  });
});
