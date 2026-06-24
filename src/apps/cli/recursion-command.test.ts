import { describe, it, expect, vi } from "vitest";
vi.mock("../../application/indexing/recursion-report.js", () => ({
  scanRecursionSuspects: vi.fn(),
  formatRecursionReport: (f: unknown[]) => `formatted:${(f as unknown[]).length}`,
}));
import { executeCheckRecursion } from "./executor.js";
import { scanRecursionSuspects } from "../../application/indexing/recursion-report.js";

describe("executeCheckRecursion", () => {
  it("exit 0 + prints when clean", async () => {
    (scanRecursionSuspects as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await executeCheckRecursion("./src", false)).toBe(0);
    expect(log).toHaveBeenCalledWith("formatted:0");
    log.mockRestore();
  });
  it("exit 1 when issues found", async () => {
    (scanRecursionSuspects as ReturnType<typeof vi.fn>).mockResolvedValue([{}]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await executeCheckRecursion("./src", false)).toBe(1);
  });
});
