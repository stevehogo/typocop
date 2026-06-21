/**
 * Wave 5 — data-touch detection unit tests (Tasks 2–4 + flags + exclusions).
 *
 * Covers per-ORM DB-touch fixtures (TypeORM/Sequelize/Mongoose/Prisma/Eloquent),
 * the ambiguity-refusal negative test, route-handler linking (NestJS decorator +
 * Express call), synthetic-Symbol minting, the events dark-by-default flag, and
 * the synthetic-exclusion sites (clustering + search).
 */
import { describe, it, expect } from "vitest";
import type { Symbol, Relationship, RelationType } from "../../../core/domain.js";
import { runDataTouchDetection } from "./index.js";
import { buildClusterGraph } from "../clustering/graph.js";
import { buildSearchIndex } from "../search/index.js";

// ─── Builders ────────────────────────────────────────────────────────────────

const FILE = "src/app.ts";

function sym(partial: Partial<Symbol> & Pick<Symbol, "id" | "name" | "kind">): Symbol {
  return {
    logicalKey: partial.id,
    location: {
      filePath: partial.location?.filePath ?? FILE,
      startLine: partial.location?.startLine ?? 1,
      startColumn: 0,
      endLine: partial.location?.endLine ?? 1,
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

/** Find the single data-touch edge of a given relType (or undefined). */
function edgeOf(rels: Relationship[], relType: RelationType): Relationship | undefined {
  return rels.find((r) => r.relType === relType);
}

// ─── DB-model detection (Task 2) ───────────────────────────────────────────────

describe("detectDBModels (Task 2)", () => {
  it("resolves @Entity('users') decorator to table users (reused real class Symbol)", () => {
    const user = sym({ id: "id:User", name: "User", kind: "class", signature: "@Entity('users') class User" });
    // A repository method that reads.
    const repo = sym({
      id: "id:UserRepo.findOne",
      name: "findOne", // not the caller — this is the callee in linkDBOperations
      kind: "method",
    });
    const caller = sym({ id: "id:svc", name: "UserService.get", kind: "method", signature: "userRepo: Repository<User>" });
    const rels = [callEdge("id:svc", "id:UserRepo.findOne")];
    const res = runDataTouchDetection([user, repo, caller], rels);

    // No synthetic model minted (the real User class is the endpoint).
    expect(res.newSymbols.filter((s) => s.synthetic && s.id.startsWith("dbmodel:"))).toHaveLength(0);
    const read = edgeOf(res.newRelationships, "readsFromDb");
    expect(read).toBeDefined();
    expect(read!.target).toBe("id:User"); // strategy 3: Repository<User>
    expect(read!.metadata.reason).toBe("db-read-findOne");
    expect(read!.metadata.confidence).toBe("0.7");
  });

  it("resolves a *Model name suffix to its stripped lower-case table", () => {
    const model = sym({ id: "id:UserModel", name: "UserModel", kind: "class", signature: "class UserModel" });
    const finder = sym({ id: "id:findAll", name: "findAll", kind: "method" });
    const caller = sym({ id: "id:user-svc", name: "UserService", kind: "method" });
    const res = runDataTouchDetection([model, finder, caller], [callEdge("id:user-svc", "id:findAll")]);
    // strategy 2: caller name "userservice" includes table "user".
    const read = edgeOf(res.newRelationships, "readsFromDb");
    expect(read).toBeDefined();
    expect(read!.target).toBe("id:UserModel");
  });

  it("resolves a models/ file-path class to a table", () => {
    const model = sym({
      id: "id:Account",
      name: "Account",
      kind: "class",
      signature: "class Account",
      location: { filePath: "src/models/Account.ts", startLine: 1, startColumn: 0, endLine: 5, endColumn: 0 },
    });
    const caller = sym({
      id: "id:repo.save",
      name: "AccountRepo",
      kind: "method",
      location: { filePath: "src/models/Account.ts", startLine: 10, startColumn: 0, endLine: 12, endColumn: 0 },
    });
    const save = sym({ id: "id:save", name: "save", kind: "method" });
    const res = runDataTouchDetection([model, caller, save], [callEdge("id:repo.save", "id:save")]);
    const write = edgeOf(res.newRelationships, "writesToDb");
    expect(write).toBeDefined();
    // The REAL class Symbol is reused as the model endpoint (table name=account,
    // but the edge target is the class's own id) — no synthetic minted here.
    expect(write!.target).toBe("id:Account"); // strategy 1: same models/ file
    expect(res.newSymbols.some((s) => s.id.startsWith("dbmodel:"))).toBe(false);
  });
});

// ─── Prisma synthesis (Task 2) ─────────────────────────────────────────────────

describe("detectPrismaModels (Task 2)", () => {
  it("synthesizes dbmodel:user from prisma.user.findMany() and emits a read edge", () => {
    const handler = sym({
      id: "id:list",
      name: "listUsers",
      kind: "function",
      signature: "async listUsers() { return prisma.user.findMany() }",
    });
    const res = runDataTouchDetection([handler], []);
    const synth = res.newSymbols.find((s) => s.id === "dbmodel:user");
    expect(synth).toBeDefined();
    expect(synth!.synthetic).toBe(true);
    expect(synth!.kind).toBe("class");
    const read = edgeOf(res.newRelationships, "readsFromDb");
    expect(read).toBeDefined();
    expect(read!.target).toBe("dbmodel:user");
    expect(read!.metadata.reason).toBe("prisma-findMany");
    expect(read!.metadata.confidence).toBe("0.85");
  });

  it("classifies prisma.post.create() as a write", () => {
    const handler = sym({ id: "id:c", name: "createPost", kind: "function", signature: "prisma.post.create(data)" });
    const res = runDataTouchDetection([handler], []);
    const write = edgeOf(res.newRelationships, "writesToDb");
    expect(write).toBeDefined();
    expect(write!.target).toBe("dbmodel:post");
    expect(write!.metadata.reason).toBe("prisma-create");
  });
});

// ─── linkDBOperations across ORMs (Task 3) ──────────────────────────────────────

describe("linkDBOperations — per-ORM fixtures (Task 3)", () => {
  it("TypeORM: repo.save(...) → writesToDb on the Repository<User> entity", () => {
    const user = sym({ id: "id:User", name: "User", kind: "class", signature: "@Entity() class User" });
    const save = sym({ id: "id:save", name: "save", kind: "method" });
    const caller = sym({ id: "id:svc", name: "Svc", kind: "method", signature: "repo: Repository<User>" });
    const res = runDataTouchDetection([user, save, caller], [callEdge("id:svc", "id:save")]);
    const write = edgeOf(res.newRelationships, "writesToDb");
    expect(write).toBeDefined();
    expect(write!.target).toBe("id:User");
    expect(write!.metadata.reason).toBe("db-write-save");
  });

  it("Sequelize: Model.findAll(...) → readsFromDb (same-file model)", () => {
    const model = sym({
      id: "id:Order",
      name: "OrderModel",
      kind: "class",
      signature: "class OrderModel extends Model",
      location: { filePath: "src/order.ts", startLine: 1, startColumn: 0, endLine: 4, endColumn: 0 },
    });
    const findAll = sym({ id: "id:findAll", name: "findAll", kind: "method" });
    const caller = sym({
      id: "id:list",
      name: "listOrders",
      kind: "function",
      location: { filePath: "src/order.ts", startLine: 6, startColumn: 0, endLine: 8, endColumn: 0 },
    });
    const res = runDataTouchDetection([model, findAll, caller], [callEdge("id:list", "id:findAll")]);
    const read = edgeOf(res.newRelationships, "readsFromDb");
    expect(read).toBeDefined();
    expect(read!.target).toBe("id:Order"); // strategy 1 same-file
    expect(read!.metadata.reason).toBe("db-read-findAll");
  });

  it("Mongoose: .updateOne(...) → writesToDb via owner class name (strategy 4)", () => {
    const model = sym({ id: "id:User", name: "UserSchema", kind: "class", signature: "new Schema(...)" });
    const owner = sym({ id: "id:UserRepo", name: "UserRepository", kind: "class" });
    const updateOne = sym({ id: "id:updateOne", name: "update", kind: "method" });
    const caller = sym({ id: "id:m", name: "touch", kind: "method", ownerId: "id:UserRepo" });
    const res = runDataTouchDetection([model, owner, updateOne, caller], [callEdge("id:m", "id:updateOne")]);
    const write = edgeOf(res.newRelationships, "writesToDb");
    expect(write).toBeDefined();
    expect(write!.target).toBe("id:User"); // owner "userrepository" includes table "user"
    expect(write!.metadata.reason).toBe("db-write-update");
  });

  it("Eloquent: ::find(...) → readsFromDb (name-match table)", () => {
    const model = sym({ id: "id:User", name: "User", kind: "class", signature: "class User extends Model" });
    const find = sym({ id: "id:find", name: "find", kind: "method" });
    const caller = sym({ id: "id:ctrl", name: "UserController", kind: "method" });
    const res = runDataTouchDetection([model, find, caller], [callEdge("id:ctrl", "id:find")]);
    const read = edgeOf(res.newRelationships, "readsFromDb");
    expect(read).toBeDefined();
    expect(read!.target).toBe("id:User");
    expect(read!.metadata.reason).toBe("db-read-find");
  });

  it("NEGATIVE: two candidate models + no disambiguator emits NO edge", () => {
    // Models live in their OWN files; the caller is in an unrelated file and its
    // name/owner/signature mention NEITHER table → all 4 precise strategies miss,
    // and with 2 models the single-model fallback cannot fire either.
    const user = sym({ id: "id:User", name: "User", kind: "class", signature: "@Entity() class User", location: { filePath: "src/user.ts", startLine: 1, startColumn: 0, endLine: 3, endColumn: 0 } });
    const order = sym({ id: "id:Order", name: "Order", kind: "class", signature: "@Entity() class Order", location: { filePath: "src/order.ts", startLine: 1, startColumn: 0, endLine: 3, endColumn: 0 } });
    const save = sym({ id: "id:save", name: "save", kind: "method" });
    const caller = sym({ id: "id:handler", name: "doThing", kind: "function", location: { filePath: "src/handlers/thing.ts", startLine: 1, startColumn: 0, endLine: 3, endColumn: 0 } });
    const res = runDataTouchDetection([user, order, save, caller], [callEdge("id:handler", "id:save")]);
    expect(edgeOf(res.newRelationships, "writesToDb")).toBeUndefined();
    expect(edgeOf(res.newRelationships, "readsFromDb")).toBeUndefined();
  });

  it("single-model fallback is OFF by default but linkable when enabled", () => {
    // Model in its own file; caller in an unrelated file, name/owner/signature
    // mention NO table → the 4 precise strategies miss, so only strategy 5
    // (single-model fallback) can produce the edge.
    const user = sym({ id: "id:User", name: "User", kind: "class", signature: "@Entity() class User", location: { filePath: "src/user.ts", startLine: 1, startColumn: 0, endLine: 3, endColumn: 0 } });
    const find = sym({ id: "id:find", name: "find", kind: "method" });
    const caller = sym({ id: "id:handler", name: "doThing", kind: "function", location: { filePath: "src/handlers/thing.ts", startLine: 1, startColumn: 0, endLine: 3, endColumn: 0 } });
    const symbols = [user, find, caller];
    const rels = [callEdge("id:handler", "id:find")];

    const off = runDataTouchDetection(symbols, rels);
    expect(edgeOf(off.newRelationships, "readsFromDb")).toBeUndefined();

    const on = runDataTouchDetection(symbols, rels, { singleModelFallback: true });
    const read = edgeOf(on.newRelationships, "readsFromDb");
    expect(read).toBeDefined();
    expect(read!.target).toBe("id:User");
  });
});

// ─── Route handler linking (Task 4) ─────────────────────────────────────────────

describe("route handler linking (Task 4)", () => {
  it("NestJS @Controller('users') + @Get(':id') links to GET /users/:id", () => {
    const ctrl = sym({ id: "id:UsersController", name: "UsersController", kind: "class", signature: "@Controller('users') class UsersController" });
    const handler = sym({ id: "id:get", name: "getOne", kind: "method", ownerId: "id:UsersController", signature: "@Get(':id') getOne()" });
    const res = runDataTouchDetection([ctrl, handler], []);
    const route = edgeOf(res.newRelationships, "handlesRoute");
    expect(route).toBeDefined();
    expect(route!.source).toBe("id:get");
    const endpoint = res.newSymbols.find((s) => s.id === route!.target);
    expect(endpoint).toBeDefined();
    expect(endpoint!.name).toBe("GET /users/:id");
    expect(endpoint!.synthetic).toBe(true);
    expect(route!.metadata.reason).toBe("decorator-Get");
    expect(route!.metadata.confidence).toBe("0.85");
  });

  it("Express router.get('/users', listUsers) links the handler to GET /users", () => {
    const handler = sym({
      id: "id:reg",
      name: "registerRoutes",
      kind: "function",
      signature: "router.get('/users', listUsers)",
      location: { filePath: "src/routes/user.ts", startLine: 1, startColumn: 0, endLine: 3, endColumn: 0 },
    });
    const get = sym({ id: "id:get", name: "get", kind: "method" });
    const res = runDataTouchDetection([handler, get], [callEdge("id:reg", "id:get")]);
    const route = edgeOf(res.newRelationships, "handlesRoute");
    expect(route).toBeDefined();
    const endpoint = res.newSymbols.find((s) => s.id === route!.target);
    expect(endpoint!.name).toBe("GET /users");
    expect(route!.metadata.reason).toBe("express-get");
    expect(route!.metadata.confidence).toBe("0.7");
  });

  it("a method with no decorator and no express call produces no endpoint", () => {
    const handler = sym({ id: "id:plain", name: "plain", kind: "method", signature: "plain() {}" });
    const res = runDataTouchDetection([handler], []);
    expect(edgeOf(res.newRelationships, "handlesRoute")).toBeUndefined();
    expect(res.newSymbols).toHaveLength(0);
  });

  it("honours alreadyLinked: a pre-linked handler is not re-linked by the regex fallback", () => {
    const ctrl = sym({ id: "id:C", name: "UsersController", kind: "class", signature: "@Controller('users')" });
    const handler = sym({ id: "id:h", name: "getOne", kind: "method", ownerId: "id:C", signature: "@Get(':id')" });
    // A structured handlesRoute edge already exists for id:h (Wave-6 seam).
    const structured: Relationship = {
      id: "handlesRoute:id:h->ext:endpoint",
      source: "id:h",
      target: "ext:endpoint",
      relType: "handlesRoute",
      metadata: { confidence: "1", reason: "ast-exact-route" },
    };
    const res = runDataTouchDetection([ctrl, handler], [structured]);
    // No NEW handlesRoute edge sourced from id:h.
    expect(res.newRelationships.filter((r) => r.relType === "handlesRoute" && r.source === "id:h")).toHaveLength(0);
  });
});

// ─── Events dark-by-default ──────────────────────────────────────────────────

describe("events flag (dark by default)", () => {
  const subscriber = sym({ id: "id:sub", name: "onUserCreated", kind: "method", signature: "@OnEvent('user.created') onUserCreated()" });

  it("emits no publishesEvent/subscribesTo edges with events OFF (default)", () => {
    const res = runDataTouchDetection([subscriber], []);
    expect(res.newRelationships.some((r) => r.relType === "subscribesTo" || r.relType === "publishesEvent")).toBe(false);
  });

  it("emits a subscribesTo edge when events ON", () => {
    const res = runDataTouchDetection([subscriber], [], { events: true });
    const sub = edgeOf(res.newRelationships, "subscribesTo");
    expect(sub).toBeDefined();
    expect(sub!.target).toBe("id:sub");
    expect(sub!.metadata.reason).toBe("decorator-OnEvent");
  });
});

// ─── Synthetic-Symbol exclusion sites (cross-cutting §2) ─────────────────────────

describe("synthetic-Symbol exclusion", () => {
  it("buildClusterGraph excludes synthetic Symbols even though they pass the kind filter", () => {
    const real = sym({ id: "id:a", name: "A", kind: "class" });
    const realB = sym({ id: "id:b", name: "B", kind: "class" });
    const synthModel = sym({ id: "dbmodel:users", name: "users", kind: "class", synthetic: true });
    const synthEndpoint = sym({ id: "apiendpoint:GET:/users", name: "GET /users", kind: "function", synthetic: true });
    const graph = buildClusterGraph(
      [real, realB, synthModel, synthEndpoint],
      [{ id: "calls:id:a->id:b", source: "id:a", target: "id:b", relType: "calls", metadata: {} }],
    );
    expect(graph.nodes.has("id:a")).toBe(true);
    expect(graph.nodes.has("dbmodel:users")).toBe(false);
    expect(graph.nodes.has("apiendpoint:GET:/users")).toBe(false);
  });

  it("buildSearchIndex skips synthetic Symbols in the keyword index + count", async () => {
    const real = sym({ id: "id:real", name: "realFunction", kind: "function" });
    const synth = sym({ id: "dbmodel:users", name: "users", kind: "class", synthetic: true });
    const index = await buildSearchIndex([real, synth], [], null);
    expect(index.symbolCount).toBe(1);
    // No keyword maps to the synthetic id.
    for (const ids of index.keywords.values()) {
      expect(ids).not.toContain("dbmodel:users");
    }
  });
});

// ─── Flag-OFF golden parity ──────────────────────────────────────────────────

describe("flag-OFF parity", () => {
  it("a graph with NO synthetics clusters identically before/after the exclusion guard", () => {
    const a = sym({ id: "id:a", name: "A", kind: "class" });
    const b = sym({ id: "id:b", name: "B", kind: "class" });
    const rels: Relationship[] = [{ id: "calls:id:a->id:b", source: "id:a", target: "id:b", relType: "calls", metadata: {} }];
    const graph = buildClusterGraph([a, b], rels);
    // Both real symbols admitted, one edge — unchanged from pre-Wave-5 behaviour.
    expect([...graph.nodes.keys()].sort()).toEqual(["id:a", "id:b"]);
    expect(graph.edgeCount).toBe(1);
  });
});
