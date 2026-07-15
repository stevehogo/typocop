import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { scanRecursionSuspects } from "./recursion-report.js";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/recursion-fixtures");

describe("scanRecursionSuspects (e2e)", () => {
  it("flags signal A (override), B (arity), C (no-progress); ignores legit recursion; shows real call text", async () => {
    const f = await scanRecursionSuspects(fixtures);

    // Signal A: TS override calling this.<ownName>().
    const derived = f.find((x) => x.filePath.endsWith("Derived.ts"));
    expect(derived?.methodName).toBe("save");
    expect(derived?.buggyCall).toContain("this.save()");

    // Signal B: PHP 0-param accessor called with an argument.
    const accessor = f.find((x) => x.filePath.endsWith("Accessor.php"));
    expect(accessor?.buggyCall).toContain("getTransId");

    // Signal C: PHP override-shadowing infinite recursion, no parent indexed,
    // matching arity — only the no-progress signal sees it.
    const selfRecurse = f.find((x) => x.filePath.endsWith("SelfRecurse.php"));
    expect(selfRecurse?.methodName).toBe("_registerPaymentFailure");
    expect(selfRecurse?.buggyCall).toContain("$this->_registerPaymentFailure()");

    // Negative: legitimate recursion (base case + argument progress).
    expect(f.some((x) => x.filePath.endsWith("Plain.ts"))).toBe(false);
  });
});
