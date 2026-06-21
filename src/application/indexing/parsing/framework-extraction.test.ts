/**
 * Wave 6 — framework-extraction wiring tests (Phase 2 side-channel).
 *
 * Asserts that the framework pass is wired through
 * {@link extractAllSymbolsWithPerFile} and is gated by
 * `TYPOCOP_FRAMEWORK_EXTRACTION` (default OFF, DELIBERATE DEVIATION from the wave
 * plan's default-ON):
 *   1. Laravel fixture → `routes.length > 0` with the flag ON, `routes: []` OFF.
 *   2. NestJS fixture → routes + event subscribers + `responseKeys` on the route
 *      handler Symbol with the flag ON; none of it with the flag OFF.
 *   3. A non-framework TS file → Phase-2 output is BYTE-IDENTICAL with the flag
 *      ON vs OFF (the path/text gate skips it, so it pays nothing and changes
 *      nothing).
 *
 * The flag is read in-process here (`extractAllSymbolsWithPerFile` runs the
 * in-process parse path under vitest), so setting `process.env` controls it.
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as path from "path";
import * as os from "node:os";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { extractAllSymbolsWithPerFile } from "./index.js";
import { runDataTouchPass } from "../data-touch/index.js";
import { FRAMEWORK_EXTRACTION_ENV } from "../../../platform/utils/limits.js";
import type { FileNode } from "../structure/index.js";

const FLAG = FRAMEWORK_EXTRACTION_ENV;

const LARAVEL_ROUTES = `<?php
Route::group(['prefix' => 'api', 'middleware' => 'auth'], function () {
    Route::apiResource('posts', PostController::class);
    Route::get('/users/{id}', [UserController::class, 'show']);
});
`;

const NESTJS_CONTROLLER = `
@Controller('users')
export class UsersController {
  @Get(':id')
  findOne() {
    return { id: 1, name: 'a' };
  }
}

@Processor('ingestion')
export class IngestionProcessor extends WorkerHost {
  async process(job: any) {}
}
`;

const PLAIN_TS = `
export function add(a: number, b: number): number {
  return a + b;
}
export class Calculator {
  total = 0;
  addTo(n: number): void { this.total += n; }
}
`;

const ELOQUENT_MODEL = `<?php
class User extends Model {
  protected $fillable = ['name', 'email'];
  public function posts() { return $this->hasMany(Post::class); }
}
`;

describe("Wave 6 — framework extraction wired into Phase 2", () => {
  let tmpDir: string;
  let prevFlag: string | undefined;

  beforeEach(async () => {
    prevFlag = process.env[FLAG];
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "typocop-wave6-"));
    await writeFile(path.join(tmpDir, "api.php"), LARAVEL_ROUTES, "utf-8");
    await writeFile(path.join(tmpDir, "users.controller.ts"), NESTJS_CONTROLLER, "utf-8");
    await writeFile(path.join(tmpDir, "math-utils.ts"), PLAIN_TS, "utf-8");
    await writeFile(path.join(tmpDir, "User.php"), ELOQUENT_MODEL, "utf-8");
  });

  afterEach(async () => {
    if (prevFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prevFlag;
    await rm(tmpDir, { recursive: true, force: true });
  });

  const laravelNode = (): FileNode[] => [
    { path: "api.php", size: LARAVEL_ROUTES.length, language: "php", mtimeMs: 0 },
  ];
  const nestNode = (): FileNode[] => [
    { path: "users.controller.ts", size: NESTJS_CONTROLLER.length, language: "typescript", mtimeMs: 0 },
  ];
  const plainNode = (): FileNode[] => [
    { path: "math-utils.ts", size: PLAIN_TS.length, language: "typescript", mtimeMs: 0 },
  ];
  const eloquentNode = (): FileNode[] => [
    { path: "User.php", size: ELOQUENT_MODEL.length, language: "php", mtimeMs: 0 },
  ];

  it("Laravel: routes.length > 0 with the flag ON, empty with the flag OFF", async () => {
    delete process.env[FLAG];
    const off = await extractAllSymbolsWithPerFile(laravelNode(), tmpDir, { useWorkerThreads: false });
    expect(off.routes).toEqual([]);
    expect(off.eventSubscribers).toEqual([]);

    process.env[FLAG] = "1";
    const on = await extractAllSymbolsWithPerFile(laravelNode(), tmpDir, { useWorkerThreads: false });
    expect(on.routes.length).toBeGreaterThan(0);
    // apiResource expands to 5 ANY routes + 1 explicit GET route = 6.
    expect(on.routes.filter((r) => r.httpMethod === "ANY")).toHaveLength(5);
    // The apiResource expansion carries the group's prefix/middleware/controller.
    const apiResShow = on.routes.find((r) => r.httpMethod === "ANY" && r.methodName === "show");
    expect(apiResShow?.controllerName).toBe("PostController");
    expect(apiResShow?.prefix).toBe("api");
    expect(apiResShow?.middleware).toEqual(["auth"]);
    // The explicit GET route resolves its own [UserController::class, 'show'].
    const getShow = on.routes.find((r) => r.httpMethod === "GET");
    expect(getShow?.controllerName).toBe("UserController");
    expect(getShow?.methodName).toBe("show");
    expect(getShow?.prefix).toBe("api");
    expect(getShow?.middleware).toEqual(["auth"]);
    // Records are carried in the per-file map too (cache round-trip source).
    expect(on.perFile.get("api.php")?.routes?.length).toBe(on.routes.length);
  });

  it("NestJS: routes + event subscribers + responseKeys ON; none OFF", async () => {
    process.env[FLAG] = "1";
    const on = await extractAllSymbolsWithPerFile(nestNode(), tmpDir, { useWorkerThreads: false });

    const route = on.routes.find((r) => r.methodName === "findOne");
    expect(route?.httpMethod).toBe("GET");
    expect(route?.prefix).toBe("users");
    expect(route?.controllerName).toBe("UsersController");
    expect(route?.handlerNodeId).toBeTruthy();

    const proc = on.eventSubscribers.find((e) => e.framework === "bullmq-processor");
    expect(proc?.topicName).toBe("ingestion");
    expect(proc?.methodName).toBe("process");

    // E3: the route handler Symbol carries responseKeys (first time it reaches a Symbol).
    const handler = on.symbols.find((s) => s.kind === "method" && s.name === "findOne");
    expect(handler?.responseKeys).toEqual(["id", "name"]);

    delete process.env[FLAG];
    const off = await extractAllSymbolsWithPerFile(nestNode(), tmpDir, { useWorkerThreads: false });
    expect(off.routes).toEqual([]);
    expect(off.eventSubscribers).toEqual([]);
    const handlerOff = off.symbols.find((s) => s.kind === "method" && s.name === "findOne");
    expect(handlerOff?.responseKeys).toBeUndefined();
  });

  it("Eloquent: model class Symbol's documentation is enriched ON, untouched OFF", async () => {
    delete process.env[FLAG];
    const off = await extractAllSymbolsWithPerFile(eloquentNode(), tmpDir, { useWorkerThreads: false });
    const userOff = off.symbols.find((s) => s.kind === "class" && s.name === "User");
    expect(userOff).toBeTruthy();
    // No framework pass → documentation is whatever the base extractor produced
    // (undefined / empty here), and certainly no Eloquent marker.
    expect(userOff?.documentation ?? "").not.toContain("Eloquent model");

    process.env[FLAG] = "1";
    const on = await extractAllSymbolsWithPerFile(eloquentNode(), tmpDir, { useWorkerThreads: false });
    const userOn = on.symbols.find((s) => s.kind === "class" && s.name === "User");
    expect(userOn?.documentation).toContain("Eloquent model");
    expect(userOn?.documentation).toContain("fillable: name, email");
    // Relations preserve the target class name (the Wave 5 signal).
    expect(userOn?.documentation).toContain("hasMany(Post)");
    // No routes/events for a pure model file.
    expect(on.routes).toEqual([]);
    expect(on.eventSubscribers).toEqual([]);
  });

  it("BOTH flags ON: a Phase-2 NestJS route feeds runDataTouchPass into a handlesRoute edge", async () => {
    // Framework extraction ON → Phase-2 emits the structured route.
    process.env[FLAG] = "1";
    const on = await extractAllSymbolsWithPerFile(nestNode(), tmpDir, { useWorkerThreads: false });
    expect(on.routes.length).toBeGreaterThan(0);

    // Stamp filePath onto the routes (the parse layer keys them by relPath) and
    // feed them as the data-touch pass's structured inputs (data-touch "ON").
    const pass = runDataTouchPass(on.symbols, [], {
      extractedRoutes: on.routes,
      extractedEvents: on.eventSubscribers,
    });

    // The structured route resolves to the real findOne handler Symbol and emits
    // a HIGH-confidence handlesRoute edge (deferring the heuristic).
    const findOne = on.symbols.find((s) => s.kind === "method" && s.name === "findOne");
    expect(findOne).toBeTruthy();
    const edge = pass.newRelationships.find(
      (r) => r.relType === "handlesRoute" && r.source === findOne!.id,
    );
    expect(edge).toBeTruthy();
    expect(edge!.metadata.reason).toBe("ast-extracted-route");
    expect(edge!.metadata.confidence).toBe("1");

    // The bullmq subscriber resolves to its process() handler via subscribesTo.
    const procHandler = on.symbols.find((s) => s.kind === "method" && s.name === "process");
    const sub = pass.newRelationships.find(
      (r) => r.relType === "subscribesTo" && r.target === procHandler?.id,
    );
    expect(sub).toBeTruthy();
    expect(sub!.metadata.confidence).toBe("1");
  });

  it("non-framework file: Phase-2 output is byte-identical flag ON vs OFF", async () => {
    delete process.env[FLAG];
    const off = await extractAllSymbolsWithPerFile(plainNode(), tmpDir, { useWorkerThreads: false });

    process.env[FLAG] = "1";
    const on = await extractAllSymbolsWithPerFile(plainNode(), tmpDir, { useWorkerThreads: false });

    // Symbols/hints unchanged; framework arrays empty either way (gate skips it).
    expect(on.symbols).toEqual(off.symbols);
    expect(on.hints).toEqual(off.hints);
    expect(on.routes).toEqual([]);
    expect(off.routes).toEqual([]);
    expect(on.eventSubscribers).toEqual([]);
    expect(off.eventSubscribers).toEqual([]);
  });
});
