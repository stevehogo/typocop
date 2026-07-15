/**
 * Laravel framework-specific parser.
 * Requirements: 14.3, 14.9
 */
import type { Symbol, FrameworkSupport } from "../../../core/domain.js";
import { extractSymbols } from "../extract-symbols.js";
import { fromSyntaxNode } from "../ast-node.js";
import { isLaravelAstRoutesEnabled } from "../../../platform/utils/limits.js";
import path from "path";
import fs from "fs/promises";
import Parser from "tree-sitter";
import PHP from "tree-sitter-php";

export const LARAVEL_SUPPORT: FrameworkSupport = {
  framework: "Laravel",
  language: "php",
  apiEndpoints: true,
  controllers: true,
  dbModels: true,
  supportedORMs: ["Eloquent"],
  tracingLevel: "full",
};

/**
 * Parse Laravel route definitions from routes files (LEGACY regex extractor).
 *
 * Task 8 disposition — REPLACED by the AST extractor. The live Phase-2 path emits
 * Laravel routes via `extractLaravelRoutes` (`laravel-routes.ts`, called from the
 * framework dispatcher), which is a strict superset of this regex (it adds
 * handler linkage, `Route::group` prefix/middleware stacks, fluent chains, and
 * `resource`/`apiResource` expansion). This function is dead scaffolding (only the
 * dead `parseLaravelFile` calls it) — and is additionally gated behind
 * `TYPOCOP_LARAVEL_AST_ROUTES` (default ON): when AST routing is on it emits NO
 * route Symbols, so even if some legacy caller were re-activated it could never
 * double-count a route the AST extractor already produced. Set the flag to
 * `0`/`false` to restore the regex emission for one-release A/B parity.
 *
 * Requirement: 14.3
 */
export async function parseRouteDefinitions(filePath: string): Promise<Symbol[]> {
  // Task 8: the AST extractor is the live, superset producer; suppress this
  // regex emission when AST routing is on so a route is never double-counted.
  if (isLaravelAstRoutesEnabled()) {
    return [];
  }

  const basename = path.basename(filePath);
  if (!basename.startsWith("web.") && !basename.startsWith("api.") && basename !== "routes.php") {
    return [];
  }

  try {
    const content = await fs.readFile(filePath, "utf-8");
    const symbols: Symbol[] = [];
    
    // Extract Route::get/post/put/delete/patch patterns
    const routePattern = /Route::(get|post|put|delete|patch|any)\s*\(\s*['"]([^'"]+)['"]/g;
    let match;
    
    while ((match = routePattern.exec(content)) !== null) {
      const [, method, uri] = match;
      const lineNumber = content.substring(0, match.index).split("\n").length;
      
      symbols.push({
        id: `laravel:route:${method}:${uri}`,
        logicalKey: `laravel:route:${method}:${uri}`,
        name: `${method.toUpperCase()} ${uri}`,
        kind: "function",
        location: {
          filePath,
          startLine: lineNumber,
          startColumn: 0,
          endLine: lineNumber,
          endColumn: 0,
        },
        visibility: "public",
        modifiers: [],
      });
    }
    
    return symbols;
  } catch {
    return [];
  }
}

/**
 * Parse Laravel Eloquent model definitions.
 * Requirement: 14.3
 */
export async function parseEloquentModels(filePath: string, parser: Parser): Promise<Symbol[]> {
  if (!filePath.includes("/Models/") && !filePath.includes("/Model/")) return [];
  
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const tree = parser.parse(content);
    const ast = fromSyntaxNode(tree.rootNode);
    const symbols = extractSymbols(ast, filePath);
    
    // Filter for classes that extend Model
    return symbols.filter((s: Symbol) => 
      s.kind === "class" && 
      s.signature && 
      (s.signature.includes("extends Model") || s.signature.includes("extends Authenticatable"))
    );
  } catch {
    return [];
  }
}

/**
 * Parse Laravel controller methods.
 * Requirement: 14.3
 */
export async function parseControllerMethods(filePath: string, parser: Parser): Promise<Symbol[]> {
  if (!filePath.includes("Controller.php")) return [];
  
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const tree = parser.parse(content);
    const ast = fromSyntaxNode(tree.rootNode);
    const symbols = extractSymbols(ast, filePath);
    
    // Filter for public methods in controller classes
    return symbols.filter((s: Symbol) => 
      s.kind === "method" && 
      s.visibility === "public" &&
      !["__construct", "__invoke"].includes(s.name)
    );
  } catch {
    return [];
  }
}

/**
 * Main entry point for Laravel parsing.
 * Orchestrates all Laravel-specific parsers.
 */
export async function parseLaravelFile(filePath: string): Promise<Symbol[]> {
  const ext = path.extname(filePath);
  const basename = path.basename(filePath);
  
  // Handle route files
  if (filePath.includes("/routes/") || basename.startsWith("web.") || basename.startsWith("api.")) {
    return parseRouteDefinitions(filePath);
  }
  
  // Handle PHP files
  if (ext === ".php") {
    const parser = new Parser();
    parser.setLanguage(PHP.php as unknown as Parser.Language);
    
    const results = await Promise.all([
      parseEloquentModels(filePath, parser),
      parseControllerMethods(filePath, parser),
    ]);
    return results.flat();
  }
  
  return [];
}
