/**
 * Wave 5 — DataFlow assembly unit tests (Task 5).
 *
 * Covers the golden `GET /users -> users` flow (handler -> service -> repo ->
 * prisma), subset dedup, the trivial handler->own-endpoint skip, and controller
 * anchoring for a non-handler entry point, all driven through the full
 * `runDataTouchPass` (detection + assembly) so the test exercises the real
 * detect->synthesize->assemble path.
 */
import { describe, it, expect } from "vitest";
import type { Symbol, Relationship } from "../../../core/domain.js";
import { runDataTouchPass } from "./index.js";
import { assembleDataFlows } from "./data-flow-assembly.js";
import { makeSyntheticSymbol, makeDataTouchEdge } from "./types.js";

const FILE = "src/users/users.controller.ts";

function sym(partial: Partial<Symbol> & Pick<Symbol, "id" | "name" | "kind">): Symbol {
  return {
    logicalKey: partial.id,
    location: {
      filePath: partial.location?.filePath ?? FILE,
      startLine: 1,
      startColumn: 0,
      endLine: 1,
      endColumn: 0,
    },
    visibility: "public",
    modifiers: [],
    ...partial,
  } as Symbol;
}

function callEdge(source: string, target: string): Relationship {
  return { id: `calls:${source}->${target}`, source, target, relType: "calls", metadata: {} };
}

describe("assembleDataFlows — GET /users -> users golden flow (Task 5)", () => {
  it("assembles handler -> service -> repo -> prisma into a Process named 'GET /users -> users' reaching table user", () => {
    // Handler: a NestJS-style @Get() method on a @Controller('users') class.
    const controller = sym({
      id: "id:UsersController",
      name: "UsersController",
      kind: "class",
      signature: "@Controller('users') class UsersController",
    });
    const handler = sym({
      id: "id:UsersController.list",
      name: "list",
      kind: "method",
      ownerId: "id:UsersController",
      signature: "@Get() list(): Promise<User[]>",
      entryPointKind: "route",
    });
    const service = sym({
      id: "id:UsersService.findAll",
      name: "findAll",
      kind: "method",
      signature: "findAll(): Promise<User[]>",
    });
    const repo = sym({
      id: "id:UsersRepo.read",
      name: "read",
      kind: "method",
      // prisma call text captured in the signature → detectPrismaModels fires.
      signature: "read() { return prisma.user.findMany(); }",
    });
    // The ORM read method the repo calls (callee name in the read set).
    const findMany = sym({ id: "id:prisma.findMany", name: "findMany", kind: "method" });

    const rels: Relationship[] = [
      callEdge("id:UsersController.list", "id:UsersService.findAll"),
      callEdge("id:UsersService.findAll", "id:UsersRepo.read"),
      callEdge("id:UsersRepo.read", "id:prisma.findMany"),
    ];

    const pass = runDataTouchPass([controller, handler, service, repo, findMany], rels);

    // Detection minted a handlesRoute edge (handler -> apiendpoint:GET:/users) and
    // a readsFromDb edge (repo -> dbmodel:user via prisma).
    expect(pass.newRelationships.some((r) => r.relType === "handlesRoute")).toBe(true);
    expect(pass.newRelationships.some((r) => r.relType === "readsFromDb")).toBe(true);
    expect(pass.newSymbols.some((s) => s.id === "dbmodel:user")).toBe(true);
    expect(pass.newSymbols.some((s) => s.id === "apiendpoint:GET:/users")).toBe(true);

    // The golden flow: exactly the GET /users -> user flow is assembled.
    const golden = pass.flows.find((f) => f.name === "GET /users -> user");
    expect(golden, `flows were: ${pass.flows.map((f) => f.name).join(" | ")}`).toBeDefined();

    // It reaches the user table (dbmodel:user is the terminal data step).
    expect(golden!.steps.some((s) => s.symbolId === "dbmodel:user")).toBe(true);
    // The endpoint anchor is injected as the first VISIBLE step (the flow starts
    // at the HTTP endpoint); the Process.entryPoint stays the code handler (the
    // actual code entry), mirroring the legacy DataFlowNode.entryPointId semantics.
    expect(golden!.steps[0].symbolId).toBe("apiendpoint:GET:/users");
    expect(golden!.entryPoint).toBe("id:UsersController.list");
    // The handler is on the path.
    expect(golden!.steps.some((s) => s.symbolId === "id:UsersController.list")).toBe(true);
  });

  it("dedup collapses the handler->service->repo->model superset over its sub-paths", () => {
    // Two entry points whose traces share the same prefix: the longer superset
    // should win and the shorter prefix (a substring of the longer trace) drop.
    const endpoint = makeSyntheticSymbol({
      id: "apiendpoint:GET:/x",
      name: "GET /x",
      kind: "function",
      filePath: FILE,
    });
    const handler = sym({ id: "h", name: "handler", kind: "method", entryPointKind: "route" });
    const service = sym({ id: "s", name: "service", kind: "method" });
    const model = makeSyntheticSymbol({ id: "dbmodel:x", name: "x", kind: "class", filePath: FILE });

    const rels: Relationship[] = [
      makeDataTouchEdge({ relType: "handlesRoute", source: "h", target: "apiendpoint:GET:/x", confidence: 0.85, reason: "decorator-Get" }),
      callEdge("h", "s"),
      makeDataTouchEdge({ relType: "readsFromDb", source: "s", target: "dbmodel:x", confidence: 0.7, reason: "db-read-find" }),
    ];

    const result = assembleDataFlows([endpoint, handler, service, model], rels);
    // Only ONE flow survives dedup for this single endpoint chain.
    expect(result.flows).toHaveLength(1);
    expect(result.flows[0].name).toBe("GET /x -> x");
  });

  it("skips the trivial handler -> own-endpoint self-reference flow", () => {
    // A handler with NO downstream data edges: its only 'flow' would be the
    // 2-step handler->own-endpoint, which is the trivial-skip case.
    const endpoint = makeSyntheticSymbol({
      id: "apiendpoint:GET:/ping",
      name: "GET /ping",
      kind: "function",
      filePath: FILE,
    });
    const handler = sym({ id: "ping", name: "ping", kind: "method", entryPointKind: "route" });
    const rels: Relationship[] = [
      makeDataTouchEdge({ relType: "handlesRoute", source: "ping", target: "apiendpoint:GET:/ping", confidence: 0.85, reason: "decorator-Get" }),
    ];
    const result = assembleDataFlows([endpoint, handler], rels);
    // handlesRoute is excluded from BFS, so the handler has no forward edge →
    // no trace ≥ minSteps → zero flows (the trivial flow never even forms).
    expect(result.flows).toHaveLength(0);
  });

  it("anchors a non-handler service-method entry point back to its controller's endpoint", () => {
    // The entry point is a high-score SERVICE method (not a route handler). Its
    // calling controller handles a route; findCallerWithRoute prepends it so the
    // flow starts at the HTTP endpoint.
    const endpoint = makeSyntheticSymbol({
      id: "apiendpoint:POST:/orders",
      name: "POST /orders",
      kind: "function",
      filePath: FILE,
    });
    const controllerMethod = sym({ id: "ctrl", name: "create", kind: "method", entryPointKind: "route" });
    const serviceMethod = sym({ id: "svc", name: "place", kind: "method", entryPointKind: "task" });
    const model = makeSyntheticSymbol({ id: "dbmodel:order", name: "order", kind: "class", filePath: FILE });

    const rels: Relationship[] = [
      makeDataTouchEdge({ relType: "handlesRoute", source: "ctrl", target: "apiendpoint:POST:/orders", confidence: 0.85, reason: "decorator-Post" }),
      callEdge("ctrl", "svc"),
      makeDataTouchEdge({ relType: "writesToDb", source: "svc", target: "dbmodel:order", confidence: 0.7, reason: "db-write-save" }),
    ];

    const result = assembleDataFlows([endpoint, controllerMethod, serviceMethod, model], rels);
    const flow = result.flows.find((f) => f.name === "POST /orders -> order");
    expect(flow, `flows: ${result.flows.map((f) => f.name).join(" | ")}`).toBeDefined();
    // findCallerWithRoute prepended the controller (entryPoint = ctrl) and the
    // endpoint anchor is then injected as the first visible step.
    expect(flow!.entryPoint).toBe("ctrl");
    expect(flow!.steps[0].symbolId).toBe("apiendpoint:POST:/orders");
    expect(flow!.steps.some((s) => s.symbolId === "ctrl")).toBe(true);
    expect(flow!.steps.some((s) => s.symbolId === "dbmodel:order")).toBe(true);
  });

  it("respects DEFAULT_CONFIG bounds (no flow below minSteps)", () => {
    // A lone handler with no edges produces no flow (minSteps=2 unmet).
    const handler = sym({ id: "solo", name: "solo", kind: "method", entryPointKind: "route" });
    const result = assembleDataFlows([handler], []);
    expect(result.flows).toHaveLength(0);
  });
});
