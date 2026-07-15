import { describe, it, expect } from "vitest";
import { formatRecursionReport, type RecursionFinding } from "./recursion-report.js";

const a: RecursionFinding = { index: 1, filePath: "src/Ipn.php", line: 398, methodName: "_registerPaymentDenial", buggyCall: "$this->_registerPaymentDenial()" };
const b: RecursionFinding = { index: 2, filePath: "src/TransportationMedia.php", line: 29, methodName: "getTransId", buggyCall: "$this->getTransId(self::TRANS_ID)" };

describe("formatRecursionReport", () => {
  it("clean summary when empty", () => {
    expect(formatRecursionReport([])).toMatch(/no self-recursion/i);
  });

  it("renders a 3-column Markdown table", () => {
    const out = formatRecursionReport([a, b]);
    expect(out).toContain("| # | Location | Buggy call |");
    expect(out).toContain("src/Ipn.php:398");
    expect(out).toContain("_registerPaymentDenial()");
    expect(out).toContain("`$this->_registerPaymentDenial()`");
    expect(out).toContain("`$this->getTransId(self::TRANS_ID)`");
    expect(out).toMatch(/2 issues/i);
  });

  it("emits valid JSON when opts.json is set", () => {
    expect(JSON.parse(formatRecursionReport([a], { json: true }))).toEqual([a]);
  });
});
