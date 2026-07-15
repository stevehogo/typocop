/**
 * Wave 5 — Task 1 acceptance: each new data-touch RelationType maps to its
 * intended snake_case Cypher edge label via the persist mapper (RELTYPE_EDGE_LABEL),
 * NOT the `READSFROMDB` that bare `toUpperCase()` would produce.
 */
import { describe, it, expect } from "vitest";
import type { RelationType } from "../../../core/domain.js";
import { RELTYPE_EDGE_LABEL } from "../pipeline.js";

/** Mirror of the persist mapper's resolution: explicit map, else toUpperCase. */
function persistLabel(relType: RelationType): string {
  return RELTYPE_EDGE_LABEL[relType] ?? relType.toUpperCase();
}

describe("RELTYPE_EDGE_LABEL (Task 1)", () => {
  it("maps the 5 camelCase data-touch types to snake_case REL tables", () => {
    expect(persistLabel("readsFromDb")).toBe("READS_FROM_DB");
    expect(persistLabel("writesToDb")).toBe("WRITES_TO_DB");
    expect(persistLabel("handlesRoute")).toBe("HANDLES_ROUTE");
    expect(persistLabel("publishesEvent")).toBe("PUBLISHES_EVENT");
    expect(persistLabel("subscribesTo")).toBe("SUBSCRIBES_TO");
  });

  it("keeps the existing dependsOn special-case", () => {
    expect(persistLabel("dependsOn")).toBe("DEPENDS_ON");
  });

  it("leaves single-word types to toUpperCase (round-trip safe)", () => {
    expect(persistLabel("calls")).toBe("CALLS");
    expect(persistLabel("inherits")).toBe("INHERITS");
    expect(persistLabel("overrides")).toBe("OVERRIDES");
  });

  it("does NOT collapse the camelCase types into the WRONG bare-uppercase label", () => {
    // The trap: toUpperCase() alone yields READSFROMDB (no underscore), which
    // matches neither the REL table nor the allow-list entry.
    expect(persistLabel("readsFromDb")).not.toBe("READSFROMDB");
  });
});
