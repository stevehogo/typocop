/**
 * Wave 6 (Task 1, KEYSTONE) — framework-extraction dispatcher.
 *
 * The single seam that turns the (previously dead) framework extractors into
 * live Phase-2 output. It REUSES the tree the parse worker already built — it
 * does NOT call the legacy `parse*File` functions that re-read the file and spin
 * up their own `Parser`. The worker already holds `tree`/`language`/`parser`/
 * `relativePath`, so this dispatcher takes them and runs the AST extractors over
 * the live tree.
 *
 * GATE: to keep non-framework files near-free, the pass first checks a cheap
 * `detectFrameworkFromPath` probe AND a quick source-text probe (`Route::`,
 * `@Controller`, `@EventPattern`, etc.). Only when one of those hits does any
 * AST walk run. A file that misses both pays only two string scans.
 *
 * WIRE stage: this dispatcher invokes the (now neutrally-named) AST extractors
 * directly. It returns:
 *   - `routes`            — `ExtractedRoute[]` (Laravel + NestJS)
 *   - `eventSubscribers`  — `ExtractedEventSubscriber[]` (NestJS events)
 *   - `symbolEnrichments` — `responseKeys` to fold onto route-handler Symbols
 *   - `extraSymbols`      — synthetic Symbols from path-driven extractors
 *                           (Magento2 XML), which legitimately read files.
 *
 * DEEPEN-stage seam: richer Laravel/NestJS-events/Eloquent extractors plug in by
 * replacing the `extract*` calls below; the record contract and the dispatch gate
 * stay stable.
 *
 * Provenance of the ported extractors: the legacy parser (typocop's pre-refactor
 * parser lineage).
 */
import type Parser from "tree-sitter";
import type { Language, Symbol } from "../../../core/domain.js";
import type { ExtractedRoute, ExtractedEventSubscriber } from "./extracted-records.js";
import { detectFrameworkFromPath } from "./framework-detection.js";
import { extractLaravelRoutes } from "./laravel-routes.js";
import { extractNestJSRoutes } from "./nestjs-routes.js";
import { extractNestJSEvents } from "./nestjs-events.js";
import { extractEloquentModels } from "./php-eloquent.js";
import { extractResponseKeys } from "./response-shape.js";
import { parseMagento2File } from "./magento2.js";

/** A `responseKeys` enrichment keyed by the handler method name. */
export interface SymbolEnrichment {
  /** Method name of the route handler (matched against `Symbol.name`). */
  readonly methodName: string;
  /** Top-level response-body keys (E3) for that handler. */
  readonly responseKeys: readonly string[];
}

/**
 * A `documentation` enrichment keyed by a class Symbol's name (T6 Eloquent).
 * Folded into the model class Symbol's `documentation` field — NO new persisted
 * Symbol field, so the Phase-2 Symbol shape (and the schema) is unchanged.
 */
export interface DocumentationEnrichment {
  /** Class name of the model (matched against `Symbol.name`, `kind:"class"`). */
  readonly className: string;
  /** Human-readable Eloquent summary appended to the class `documentation`. */
  readonly documentation: string;
}

/** Output of the framework pass for one file. All arrays are plain JSON. */
export interface FrameworkRecords {
  readonly routes: ExtractedRoute[];
  readonly eventSubscribers: ExtractedEventSubscriber[];
  /** `responseKeys` to fold onto matching route-handler Symbols (E3). */
  readonly symbolEnrichments: SymbolEnrichment[];
  /** Eloquent model `documentation` to fold onto matching class Symbols (T6). */
  readonly documentationEnrichments: DocumentationEnrichment[];
  /** Synthetic Symbols from path-driven extractors (Magento2 XML). */
  readonly extraSymbols: Symbol[];
}

const EMPTY: FrameworkRecords = {
  routes: [],
  eventSubscribers: [],
  symbolEnrichments: [],
  documentationEnrichments: [],
  extraSymbols: [],
};

/** Cheap source-text markers that a TS/JS file may contain framework constructs. */
const TS_PROBE = /@(Controller|Get|Post|Put|Patch|Delete|All|EventPattern|MessagePattern|Processor|WorkerHost|Consumer|RabbitSubscribe)\b/;
/** Cheap source-text marker that a PHP file may contain Laravel routing. */
const PHP_ROUTE_PROBE = /Route::|#\[Route\(/;
/** Cheap source-text marker that a PHP file may declare an Eloquent model. */
const PHP_ELOQUENT_PROBE = /extends\s+(?:Model|Authenticatable)\b/;

/**
 * Run the framework pass over an already-parsed tree.
 *
 * @param tree         the live tree-sitter tree the worker parsed
 * @param language     the file's language
 * @param relativePath path relative to the index root (stamped on records)
 * @param sourceText   the file's UTF-8 content (already read by the worker) —
 *                     used only for the cheap text probe
 * @param absolutePath absolute path, for the path-driven Magento2 XML branch
 *
 * Pure (no throws that escape): each extractor is wrapped so a degenerate tree
 * never breaks the parse worker.
 */
export async function extractFrameworkRecords(
  tree: Parser.Tree,
  language: Language,
  relativePath: string,
  sourceText: string,
  absolutePath: string,
): Promise<FrameworkRecords> {
  // ── Magento2 XML branch (path-driven; reads the file itself) ────────────────
  // Magento2 config is XML — there is no tree-sitter tree for `.xml`, so this is
  // the one extractor that legitimately reads files. Gate on the known basenames.
  if (relativePath.endsWith(".xml")) {
    const base = baseName(relativePath);
    if (base === "webapi.xml" || base === "events.xml" || base === "di.xml") {
      try {
        const extraSymbols = await parseMagento2File(absolutePath);
        return { ...EMPTY, extraSymbols };
      } catch {
        return EMPTY;
      }
    }
    return EMPTY;
  }

  // ── Cheap gate: skip entirely unless a path or text probe hits ──────────────
  const pathHint = detectFrameworkFromPath(relativePath);
  const phpTextHit =
    language === "php" && (PHP_ROUTE_PROBE.test(sourceText) || PHP_ELOQUENT_PROBE.test(sourceText));
  const tsTextHit =
    (language === "typescript" || language === "javascript") && TS_PROBE.test(sourceText);
  if (pathHint === null && !phpTextHit && !tsTextHit) {
    return EMPTY;
  }

  const routes: ExtractedRoute[] = [];
  const eventSubscribers: ExtractedEventSubscriber[] = [];
  const symbolEnrichments: SymbolEnrichment[] = [];
  const documentationEnrichments: DocumentationEnrichment[] = [];

  try {
    if (language === "php") {
      routes.push(...extractLaravelRoutes(tree, relativePath));
      // T6 Eloquent: enrich model class Symbols with `$fillable`/relations.
      // Gated on the `extends Model/Authenticatable` filter inside the extractor.
      collectEloquentEnrichments(tree, documentationEnrichments);
    } else if (language === "typescript" || language === "javascript") {
      routes.push(...extractNestJSRoutes(tree, relativePath));
      eventSubscribers.push(...extractNestJSEvents(tree, relativePath));
      // E3: stamp `responseKeys` on each route handler's Symbol. The actual
      // attachment to the Symbol happens in the worker (it owns `result.symbols`);
      // here we only compute the keys per handler method node.
      collectResponseKeyEnrichments(tree, language, routes, symbolEnrichments);
    }
  } catch {
    // A degenerate tree blew up an extractor — return whatever we collected so
    // far; never let a framework walk take down the parse worker.
  }

  return { routes, eventSubscribers, symbolEnrichments, documentationEnrichments, extraSymbols: [] };
}

/**
 * For each Eloquent model class on the tree, build a `documentation` summary
 * string (`Eloquent model | fillable: name, email | relations: hasMany(Post)`)
 * to fold onto the model's class Symbol. Only classes that pass the
 * `extends Model`/`Authenticatable` gate produce an enrichment.
 */
function collectEloquentEnrichments(tree: Parser.Tree, out: DocumentationEnrichment[]): void {
  for (const model of extractEloquentModels(tree)) {
    const parts: string[] = ["Eloquent model"];
    for (const [prop, desc] of Object.entries(model.properties)) {
      parts.push(`${prop}: ${desc}`);
    }
    if (model.relations.length > 0) {
      parts.push(`relations: ${model.relations.join(", ")}`);
    }
    // A bare `extends Model` with no indexed props/relations still enriches with
    // the marker, so Wave 5 can recognise the model — but only emit when there is
    // signal beyond the marker to keep non-model output untouched.
    if (parts.length > 1) {
      out.push({ className: model.className, documentation: parts.join(" | ") });
    }
  }
}

/** basename without importing `node:path` (keeps this module dependency-light). */
function baseName(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? norm : norm.slice(idx + 1);
}

/**
 * For each extracted route with a `methodName`, find the handler's
 * `method_definition` node and compute its `responseKeys` (E3). De-duplicated by
 * method name (last definition wins, matching the legacy shape probe).
 */
function collectResponseKeyEnrichments(
  tree: Parser.Tree,
  language: Language,
  routes: readonly ExtractedRoute[],
  out: SymbolEnrichment[],
): void {
  const wanted = new Set<string>();
  for (const r of routes) {
    if (r.methodName) wanted.add(r.methodName);
  }
  if (wanted.size === 0) return;

  const methodNodes = new Map<string, Parser.SyntaxNode>();
  const walk = (node: Parser.SyntaxNode): void => {
    if (node.type === "method_definition") {
      const name = node.childForFieldName("name")?.text;
      if (name && wanted.has(name)) methodNodes.set(name, node);
    }
    for (const child of node.namedChildren) walk(child);
  };
  walk(tree.rootNode);

  for (const [methodName, node] of methodNodes) {
    const responseKeys = extractResponseKeys(node, language);
    if (responseKeys.length > 0) {
      out.push({ methodName, responseKeys });
    }
  }
}
