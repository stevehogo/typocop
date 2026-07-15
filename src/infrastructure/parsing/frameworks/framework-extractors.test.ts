/**
 * Wave 6 — AST framework-extractor unit tests (over the live tree-sitter tree).
 *
 * Covers the three handler syntaxes + resource expansion (Laravel), decorator
 * linkage + grammar-drift fallbacks (NestJS routes/events), and the Eloquent
 * property/relationship description helpers. These give the DEEPEN stage a
 * regression net before the richer extractors replace these.
 */
import { describe, it, expect, beforeAll } from "vitest";
import Parser from "tree-sitter";
import { initParser } from "../init.js";
import { extractLaravelRoutes } from "./laravel-routes.js";
import { extractNestJSRoutes } from "./nestjs-routes.js";
import { extractNestJSEvents } from "./nestjs-events.js";
import {
  extractPhpPropertyDescription,
  extractEloquentRelationDescription,
  extractEloquentModels,
} from "./php-eloquent.js";

describe("extractLaravelRoutes", () => {
  let php: Parser;
  beforeAll(async () => {
    php = await initParser("php");
  });

  it("expands apiResource to 5 action routes with group prefix/middleware", () => {
    const tree = php.parse(`<?php
Route::group(['prefix' => 'api', 'middleware' => ['auth', 'throttle']], function () {
    Route::apiResource('posts', PostController::class);
});
`);
    const routes = extractLaravelRoutes(tree, "routes/api.php");
    expect(routes).toHaveLength(5);
    expect(routes.map((r) => r.methodName).sort()).toEqual(
      ["destroy", "index", "show", "store", "update"].sort(),
    );
    for (const r of routes) {
      expect(r.httpMethod).toBe("ANY");
      expect(r.controllerName).toBe("PostController");
      expect(r.prefix).toBe("api");
      expect(r.middleware).toEqual(["auth", "throttle"]);
    }
  });

  it("expands resource to 7 action routes", () => {
    const tree = php.parse(`<?php Route::resource('photos', PhotoController::class);`);
    const routes = extractLaravelRoutes(tree, "routes/web.php");
    expect(routes).toHaveLength(7);
  });

  it("resolves the array handler syntax [C::class, 'm']", () => {
    const tree = php.parse(`<?php Route::get('/x', [UserController::class, 'index']);`);
    const [r] = extractLaravelRoutes(tree, "routes/web.php");
    expect(r).toMatchObject({ httpMethod: "GET", controllerName: "UserController", methodName: "index" });
  });

  it("resolves the string handler syntax 'C@m'", () => {
    const tree = php.parse(`<?php Route::post('/y', 'AuthController@login');`);
    const [r] = extractLaravelRoutes(tree, "routes/web.php");
    expect(r).toMatchObject({ httpMethod: "POST", controllerName: "AuthController", methodName: "login" });
  });

  it("resolves an invokable controller C::class to __invoke", () => {
    const tree = php.parse(`<?php Route::get('/z', InvokableController::class);`);
    const [r] = extractLaravelRoutes(tree, "routes/web.php");
    expect(r).toMatchObject({ controllerName: "InvokableController", methodName: "__invoke" });
  });
});

describe("extractNestJSRoutes", () => {
  let ts: Parser;
  beforeAll(async () => {
    ts = await initParser("typescript");
  });

  it("links a @Get(':id') method to its controller with prefix + handlerNodeId", () => {
    const tree = ts.parse(`
@Controller('users')
export class UsersController {
  @Get(':id')
  findOne() {}
  @Post()
  create() {}
}
`);
    const routes = extractNestJSRoutes(tree, "users.controller.ts");
    expect(routes).toHaveLength(2);
    const findOne = routes.find((r) => r.methodName === "findOne");
    expect(findOne).toMatchObject({
      httpMethod: "GET",
      routePath: ":id",
      controllerName: "UsersController",
      prefix: "users",
    });
    expect(findOne?.handlerNodeId).toBeTruthy();
    expect(routes.find((r) => r.methodName === "create")?.httpMethod).toBe("POST");
  });
});

describe("extractNestJSEvents", () => {
  let ts: Parser;
  beforeAll(async () => {
    ts = await initParser("typescript");
  });

  it("extracts @EventPattern (nestjs-event) and @MessagePattern (nestjs-message)", () => {
    const tree = ts.parse(`
class EventsController {
  @EventPattern('user.signup')
  onSignup() {}
  @MessagePattern('order.create')
  onCreate() {}
}
`);
    const events = extractNestJSEvents(tree, "events.controller.ts");
    expect(events.find((e) => e.topicName === "user.signup")?.framework).toBe("nestjs-event");
    expect(events.find((e) => e.topicName === "order.create")?.framework).toBe("nestjs-message");
  });

  it("extracts a class-level @Processor → bullmq-processor with the handler method", () => {
    const tree = ts.parse(`
@Processor('ingestion')
export class IngestionProcessor extends WorkerHost {
  async process(job: any) {}
}
`);
    const [e] = extractNestJSEvents(tree, "ingestion.processor.ts");
    expect(e).toMatchObject({
      topicName: "ingestion",
      className: "IngestionProcessor",
      methodName: "process",
      framework: "bullmq-processor",
    });
  });
});

describe("php-eloquent helpers", () => {
  let php: Parser;
  beforeAll(async () => {
    php = await initParser("php");
  });

  /** Find the first node of `type` in a parsed source. */
  function firstOf(src: string, type: string): Parser.SyntaxNode {
    const tree = php.parse(src);
    let found: Parser.SyntaxNode | null = null;
    const walk = (n: Parser.SyntaxNode): void => {
      if (!found && n.type === type) found = n;
      for (const c of n.children) walk(c);
    };
    walk(tree.rootNode);
    if (!found) throw new Error(`no ${type} node`);
    return found;
  }

  it("indexes a $fillable array property as a comma-joined description", () => {
    const node = firstOf(`<?php class User extends Model { protected $fillable = ['name', 'email']; }`, "property_declaration");
    expect(extractPhpPropertyDescription("fillable", node)).toBe("name, email");
  });

  it("indexes a $casts array property as key:value pairs", () => {
    const node = firstOf(`<?php class User extends Model { protected $casts = ['verified' => 'boolean']; }`, "property_declaration");
    expect(extractPhpPropertyDescription("casts", node)).toBe("verified:boolean");
  });

  it("returns null for a non-Eloquent property name", () => {
    const node = firstOf(`<?php class User { protected $other = ['x']; }`, "property_declaration");
    expect(extractPhpPropertyDescription("other", node)).toBeNull();
  });

  it("describes a hasMany(Post) relationship from $this->hasMany(Post::class)", () => {
    const method = firstOf(
      `<?php class User extends Model { public function posts() { return $this->hasMany(Post::class); } }`,
      "method_declaration",
    );
    expect(extractEloquentRelationDescription(method)).toBe("hasMany(Post)");
  });

  it("extracts a full model (fillable + casts + relations) gated on extends Model", () => {
    const tree = php.parse(`<?php
class User extends Model {
  protected $fillable = ['name', 'email'];
  protected $casts = ['verified' => 'boolean'];
  public function posts() { return $this->hasMany(Post::class); }
  public function team() { return $this->belongsTo(Team::class); }
}
class Plain {
  protected $other = ['x'];
}`);
    const models = extractEloquentModels(tree);
    expect(models).toHaveLength(1);
    const [user] = models;
    expect(user.className).toBe("User");
    expect(user.properties.fillable).toBe("name, email");
    expect(user.properties.casts).toBe("verified:boolean");
    // Relations preserve the TARGET class name — the useful Wave 5 signal.
    expect(user.relations).toEqual(["hasMany(Post)", "belongsTo(Team)"]);
  });

  it("does not treat a non-Model class as an Eloquent model", () => {
    const tree = php.parse(`<?php class Service { protected $fillable = ['a']; }`);
    expect(extractEloquentModels(tree)).toEqual([]);
  });

  it("treats extends Authenticatable as a model too", () => {
    const tree = php.parse(`<?php class User extends Authenticatable { protected $fillable = ['name']; }`);
    const models = extractEloquentModels(tree);
    expect(models).toHaveLength(1);
    expect(models[0].properties.fillable).toBe("name");
  });
});
