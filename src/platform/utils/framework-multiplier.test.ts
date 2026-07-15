/**
 * Wave 2 (1.1) — path-based framework entry-point multiplier (pure data table).
 */
import { describe, it, expect } from "vitest";
import { frameworkEntryPointMultiplier } from "./framework-multiplier.js";

describe("frameworkEntryPointMultiplier", () => {
  it("returns null for a plain library path (1.0 fallback)", () => {
    expect(frameworkEntryPointMultiplier("/repo/src/lib/users.ts")).toBeNull();
  });

  it("boosts a Next.js API route", () => {
    const hint = frameworkEntryPointMultiplier("/repo/pages/api/users.ts");
    expect(hint?.multiplier).toBe(3.0);
    expect(hint?.reason).toBe("nextjs-api-route");
  });

  it("boosts an Express routes folder", () => {
    const hint = frameworkEntryPointMultiplier("/repo/src/routes/user.ts");
    expect(hint?.multiplier).toBe(2.5);
    expect(hint?.reason).toBe("routes-folder");
  });

  it("boosts a Django views file", () => {
    const hint = frameworkEntryPointMultiplier("/repo/app/views.py");
    expect(hint?.multiplier).toBe(3.0);
    expect(hint?.reason).toBe("django-views");
  });

  it("boosts a Spring controller", () => {
    const hint = frameworkEntryPointMultiplier("/repo/src/controller/UserController.java");
    expect(hint?.framework).toBe("spring");
    expect(hint?.multiplier).toBe(3.0);
  });

  it("boosts a Go main entry", () => {
    const hint = frameworkEntryPointMultiplier("/repo/cmd/server/main.go");
    expect(hint?.reason).toBe("go-main");
    expect(hint?.multiplier).toBe(3.0);
  });

  it("boosts a Rust main", () => {
    expect(frameworkEntryPointMultiplier("/repo/src/main.rs")?.reason).toBe("rust-main");
  });

  it("normalizes Windows separators + missing leading slash", () => {
    const hint = frameworkEntryPointMultiplier("pages\\api\\users.ts");
    expect(hint?.reason).toBe("nextjs-api-route");
  });

  it("boosts a Laravel controller-by-name", () => {
    expect(frameworkEntryPointMultiplier("/repo/app/UserController.php")?.framework).toBe("laravel");
  });
});
