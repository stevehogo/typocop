import { describe, it } from "vitest";
import fc from "fast-check";
import type { ASTNode } from "../parser/index.js";
import { extractSymbols } from "../parser/index.js";

// Helper to generate a valid symbol node
const symbolNodeArbitrary = (): fc.Arbitrary<ASTNode> =>
  fc.record({
    type: fc.constantFrom("function_declaration", "class_declaration", "interface_declaration"),
    startPosition: fc.constant({ row: 1, column: 0 }),
    endPosition: fc.constant({ row: 10, column: 0 }),
    children: fc.array(fc.record({
      type: fc.constant("identifier"),
      startPosition: fc.constant({ row: 1, column: 9 }),
      endPosition: fc.constant({ row: 1, column: 20 }),
      children: fc.constant([]),
      text: fc.string({ minLength: 1 })
    }), { minLength: 1, maxLength: 1 }),
    text: fc.string()
  });

// Generate arbitrary ASTs that contain symbols
const astArbitrary = fc.letrec(tie => ({
  node: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    symbolNodeArbitrary(), // Base valid symbol we want to extract
    fc.record({           // Or a recursive container node
      type: fc.constantFrom("program", "expression_statement", "block"),
      startPosition: fc.constant({ row: 1, column: 0 }),
      endPosition: fc.constant({ row: 1, column: 0 }),
      children: fc.array(tie('node') as fc.Arbitrary<ASTNode>, { maxLength: 5 }),
      text: fc.string()
    })
  )
})).node as fc.Arbitrary<ASTNode>;

describe("Phase 2 Correctness Properties", () => {
  it("Property 1: Symbol Uniqueness - Verify no duplicate IDs in extracted symbols", () => {
    // Generate an AST that might contain multiple valid symbol nodes 
    // (using our arbitrary structural definitions) and extract them.
    // The extraction mechanism MUST assign mathematically separate UUIDs.
    fc.assert(
      fc.property(astArbitrary, (ast) => {
        const symbols = extractSymbols(ast, "test.ts");
        const ids = symbols.map(s => s.id);
        const isUniqueList = new Set(ids).size === ids.length;
        
        // As a sanity check, ensure UUID format
        const validUUIDs = ids.every(id => 
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
        );

        return isUniqueList && validUUIDs;
      })
    );
  });
});
