import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { scanRecursionSuspects } from "./recursion-report.js";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/recursion-fixtures");

describe("scanRecursionSuspects (e2e)", () => {
  it("flags signal A (override) + signal B (arity), ignores legit recursion, shows real call text", async () => {
    const f = await scanRecursionSuspects(fixtures);

    const derived = f.find((x) => x.filePath.endsWith("Derived.ts"));
    expect(derived?.methodName).toBe("save");
    expect(derived?.buggyCall).toContain("this.save()");

    const accessor = f.find((x) => x.filePath.endsWith("Accessor.php"));
    expect(accessor?.buggyCall).toContain("getTransId");

    expect(f.some((x) => x.filePath.endsWith("Plain.ts"))).toBe(false);
  });
});
