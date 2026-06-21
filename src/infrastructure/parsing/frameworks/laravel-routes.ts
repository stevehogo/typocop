/**
 * Wave 6 — Laravel route extractor (AST).
 *
 * Walks a PHP tree-sitter tree and emits structured {@link ExtractedRoute}s:
 *   - `Route::get|post|put|patch|delete|options|any|match(...)`
 *   - `Route::resource` / `Route::apiResource` expansion (7 / 5 action routes)
 *   - `Route::group([...], fn)` prefix/middleware stacks
 *   - fluent chains: `Route::middleware('auth')->prefix('api')->group(fn)`
 *   - all three handler syntaxes: `[C::class,'m']`, `'C@m'`, invokable `C::class`
 *
 * Operates on the ALREADY-PARSED tree the worker holds (no second `fs.readFile`,
 * no new `Parser`). Raw tree-sitter node access is intentional — `childForFieldName`
 * with a `children.find` fallback handles grammar-version drift; an `ASTNode`
 * wrapper would hide the field-name access this walk relies on.
 *
 * Provenance: ported from the legacy parser (typocop's pre-refactor parser
 * lineage). The nodes are tree-sitter raw nodes, hence `any`-typed.
 */
import type { ExtractedRoute } from "./extracted-records.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface RouteGroupContext {
  middleware: string[];
  prefix: string | null;
  controller: string | null;
}

const ROUTE_HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "any", "match"]);
const ROUTE_RESOURCE_METHODS = new Set(["resource", "apiResource"]);
const RESOURCE_ACTIONS = ["index", "create", "store", "show", "edit", "update", "destroy"];
const API_RESOURCE_ACTIONS = ["index", "store", "show", "update", "destroy"];

/** Find any descendant node by type (DFS, first hit). */
export function findDescendant(node: any, type: string): any | null {
  if (node.type === type) return node;
  for (const child of node.children ?? []) {
    const found = findDescendant(child, type);
    if (found) return found;
  }
  return null;
}

/** Extract the inner text of a `string` / `encapsed_string` node (drops quotes). */
export function extractStringContent(node: any): string | null {
  if (!node) return null;
  if (node.type === "string" || node.type === "encapsed_string") {
    if (node.childCount >= 3 && node.children) {
      return node.children.slice(1, -1).map((c: any) => c.text).join("");
    }
    return node.text?.replace(/^['"](.*)['"]$/, "$1") ?? null;
  }
  return null;
}

/** Is this a `scoped_call_expression` whose object is `Route`? */
export function isRouteStaticCall(node: any): boolean {
  if (node.type !== "scoped_call_expression") return false;
  const obj = node.childForFieldName?.("object") ?? node.children?.[0];
  return obj?.text === "Route";
}

/** Method name of a `scoped_call_expression` / `member_call_expression`. */
export function getCallMethodName(node: any): string | null {
  const nameNode = node.childForFieldName?.("name") ?? node.children?.find((c: any) => c.type === "name");
  return nameNode?.text ?? null;
}

/** The `arguments` node of a call expression. */
export function getArguments(node: any): any {
  return node.children?.find((c: any) => c.type === "arguments") ?? null;
}

/** Find the closure body inside an `arguments` node. */
export function findClosureBody(argsNode: any): any | null {
  if (!argsNode) return null;
  for (const child of argsNode.children ?? []) {
    if (child.type === "argument") {
      for (const inner of child.children ?? []) {
        if (inner.type === "anonymous_function" || inner.type === "arrow_function") {
          return inner.childForFieldName?.("body") ?? inner.children?.find((c: any) => c.type === "compound_statement");
        }
      }
    }
    if (child.type === "anonymous_function" || child.type === "arrow_function") {
      return child.childForFieldName?.("body") ?? child.children?.find((c: any) => c.type === "compound_statement");
    }
  }
  return null;
}

/** First string argument from an `arguments` node. */
export function extractFirstStringArg(argsNode: any): string | null {
  if (!argsNode) return null;
  for (const child of argsNode.children ?? []) {
    const target = child.type === "argument" ? child.children?.[0] : child;
    if (!target) continue;
    if (target.type === "string" || target.type === "encapsed_string") {
      return extractStringContent(target);
    }
  }
  return null;
}

/** Middleware from an `arguments` node — handles a single string or an array. */
export function extractMiddlewareArg(argsNode: any): string[] {
  if (!argsNode) return [];
  for (const child of argsNode.children ?? []) {
    const target = child.type === "argument" ? child.children?.[0] : child;
    if (!target) continue;
    if (target.type === "string" || target.type === "encapsed_string") {
      const val = extractStringContent(target);
      return val ? [val] : [];
    }
    if (target.type === "array_creation_expression") {
      const items: string[] = [];
      for (const el of target.children ?? []) {
        if (el.type === "array_element_initializer") {
          const str = el.children?.find((c: any) => c.type === "string" || c.type === "encapsed_string");
          const val = str ? extractStringContent(str) : null;
          if (val) items.push(val);
        }
      }
      return items;
    }
  }
  return [];
}

/** `Controller::class` from an `arguments` node (e.g. `->controller(C::class)`). */
export function extractClassArg(argsNode: any): string | null {
  if (!argsNode) return null;
  for (const child of argsNode.children ?? []) {
    const target = child.type === "argument" ? child.children?.[0] : child;
    if (target?.type === "class_constant_access_expression") {
      return target.children?.find((c: any) => c.type === "name")?.text ?? null;
    }
  }
  return null;
}

/**
 * Resolve the route handler target from an `arguments` node. Covers the three
 * handler syntaxes: `[C::class,'m']`, `'C@m'`, invokable `C::class` (`__invoke`).
 */
export function extractControllerTarget(argsNode: any): { controller: string | null; method: string | null } {
  if (!argsNode) return { controller: null, method: null };

  const args: any[] = [];
  for (const child of argsNode.children ?? []) {
    if (child.type === "argument") args.push(child.children?.[0]);
    else if (child.type !== "(" && child.type !== ")" && child.type !== ",") args.push(child);
  }

  const handlerNode = args[1];
  if (!handlerNode) return { controller: null, method: null };

  if (handlerNode.type === "array_creation_expression") {
    let controller: string | null = null;
    let method: string | null = null;
    const elements: any[] = [];
    for (const el of handlerNode.children ?? []) {
      if (el.type === "array_element_initializer") elements.push(el);
    }
    if (elements[0]) {
      const classAccess = findDescendant(elements[0], "class_constant_access_expression");
      if (classAccess) {
        controller = classAccess.children?.find((c: any) => c.type === "name")?.text ?? null;
      }
    }
    if (elements[1]) {
      const str = findDescendant(elements[1], "string");
      method = str ? extractStringContent(str) : null;
    }
    return { controller, method };
  }

  if (handlerNode.type === "string" || handlerNode.type === "encapsed_string") {
    const text = extractStringContent(handlerNode);
    if (text?.includes("@")) {
      const [controller, method] = text.split("@");
      return { controller, method };
    }
  }

  if (handlerNode.type === "class_constant_access_expression") {
    const controller = handlerNode.children?.find((c: any) => c.type === "name")?.text ?? null;
    return { controller, method: "__invoke" };
  }

  return { controller: null, method: null };
}

interface ChainedRouteCall {
  isRouteFacade: boolean;
  terminalMethod: string;
  attributes: { method: string; argsNode: any }[];
  terminalArgs: any;
  node: any;
}

/** Unwrap a chain like `Route::middleware('auth')->prefix('api')->group(fn)`. */
export function unwrapRouteChain(node: any): ChainedRouteCall | null {
  if (node.type !== "member_call_expression") return null;

  const terminalMethod = getCallMethodName(node);
  if (!terminalMethod) return null;

  const terminalArgs = getArguments(node);
  const attributes: { method: string; argsNode: any }[] = [];

  let current = node.children?.[0];

  while (current) {
    if (current.type === "member_call_expression") {
      const method = getCallMethodName(current);
      const args = getArguments(current);
      if (method) attributes.unshift({ method, argsNode: args });
      current = current.children?.[0];
    } else if (current.type === "scoped_call_expression") {
      const obj = current.childForFieldName?.("object") ?? current.children?.[0];
      if (obj?.text !== "Route") return null;

      const method = getCallMethodName(current);
      const args = getArguments(current);
      if (method) attributes.unshift({ method, argsNode: args });

      return { isRouteFacade: true, terminalMethod, attributes, terminalArgs, node };
    } else {
      break;
    }
  }

  return null;
}

/** Parse `Route::group(['middleware'=>.., 'prefix'=>.., 'controller'=>..], fn)`. */
export function parseArrayGroupArgs(argsNode: any): RouteGroupContext {
  const ctx: RouteGroupContext = { middleware: [], prefix: null, controller: null };
  if (!argsNode) return ctx;

  for (const child of argsNode.children ?? []) {
    const target = child.type === "argument" ? child.children?.[0] : child;
    if (target?.type === "array_creation_expression") {
      for (const el of target.children ?? []) {
        if (el.type !== "array_element_initializer") continue;
        const children = el.children ?? [];
        const arrowIdx = children.findIndex((c: any) => c.type === "=>");
        if (arrowIdx === -1) continue;
        const key = extractStringContent(children[arrowIdx - 1]);
        const val = children[arrowIdx + 1];
        if (key === "middleware") {
          if (val?.type === "string") {
            const s = extractStringContent(val);
            if (s) ctx.middleware.push(s);
          } else if (val?.type === "array_creation_expression") {
            for (const item of val.children ?? []) {
              if (item.type === "array_element_initializer") {
                const str = item.children?.find((c: any) => c.type === "string");
                const s = str ? extractStringContent(str) : null;
                if (s) ctx.middleware.push(s);
              }
            }
          }
        } else if (key === "prefix") {
          ctx.prefix = extractStringContent(val) ?? null;
        } else if (key === "controller") {
          if (val?.type === "class_constant_access_expression") {
            ctx.controller = val.children?.find((c: any) => c.type === "name")?.text ?? null;
          }
        }
      }
    }
  }
  return ctx;
}

/** Walk the tree and emit structured Laravel routes. */
export function extractLaravelRoutes(tree: any, filePath: string): ExtractedRoute[] {
  const routes: ExtractedRoute[] = [];

  function resolveStack(stack: RouteGroupContext[]): {
    middleware: string[];
    prefix: string | null;
    controller: string | null;
  } {
    const middleware: string[] = [];
    let prefix: string | null = null;
    let controller: string | null = null;
    for (const ctx of stack) {
      middleware.push(...ctx.middleware);
      if (ctx.prefix) prefix = prefix ? `${prefix}/${ctx.prefix}`.replace(/\/+/g, "/") : ctx.prefix;
      if (ctx.controller) controller = ctx.controller;
    }
    return { middleware, prefix, controller };
  }

  function emitRoute(
    httpMethod: string,
    argsNode: any,
    lineNumber: number,
    groupStack: RouteGroupContext[],
    chainAttrs: { method: string; argsNode: any }[],
  ): void {
    const effective = resolveStack(groupStack);

    for (const attr of chainAttrs) {
      if (attr.method === "middleware") effective.middleware.push(...extractMiddlewareArg(attr.argsNode));
      if (attr.method === "prefix") {
        const pfx = extractFirstStringArg(attr.argsNode);
        if (pfx) effective.prefix = effective.prefix ? `${effective.prefix}/${pfx}` : pfx;
      }
      if (attr.method === "controller") {
        const cls = extractClassArg(attr.argsNode);
        if (cls) effective.controller = cls;
      }
    }

    const routePath = extractFirstStringArg(argsNode);

    if (ROUTE_RESOURCE_METHODS.has(httpMethod)) {
      const target = extractControllerTarget(argsNode);
      const actions = httpMethod === "apiResource" ? API_RESOURCE_ACTIONS : RESOURCE_ACTIONS;
      for (const action of actions) {
        routes.push({
          filePath,
          httpMethod: "ANY",
          routePath: routePath ? `${routePath}/${action}` : null,
          controllerName: target.controller ?? effective.controller,
          methodName: action,
          middleware: [...effective.middleware],
          prefix: effective.prefix,
          lineNumber,
        });
      }
    } else {
      const methods = httpMethod === "match" ? extractMiddlewareArg(argsNode) : [httpMethod];
      const targetCtx =
        ROUTE_HTTP_METHODS.has(httpMethod) || httpMethod === "match"
          ? extractControllerTarget(argsNode)
          : { controller: null, method: null };

      for (const method of methods) {
        routes.push({
          filePath,
          httpMethod: method.toUpperCase(),
          routePath,
          controllerName: targetCtx.controller ?? effective.controller,
          methodName: targetCtx.method,
          middleware: [...effective.middleware],
          prefix: effective.prefix,
          lineNumber,
        });
      }
    }
  }

  function walk(node: any, groupStack: RouteGroupContext[]): void {
    if (isRouteStaticCall(node)) {
      const method = getCallMethodName(node);
      if (method && (ROUTE_HTTP_METHODS.has(method) || ROUTE_RESOURCE_METHODS.has(method))) {
        emitRoute(method, getArguments(node), node.startPosition.row, groupStack, []);
        return;
      }
      if (method === "group") {
        const argsNode = getArguments(node);
        const groupCtx = parseArrayGroupArgs(argsNode);
        const body = findClosureBody(argsNode);
        if (body) {
          groupStack.push(groupCtx);
          walkChildren(body, groupStack);
          groupStack.pop();
        }
        return;
      }
    }

    const chain = unwrapRouteChain(node);
    if (chain) {
      if (chain.terminalMethod === "group") {
        const groupCtx: RouteGroupContext = { middleware: [], prefix: null, controller: null };
        for (const attr of chain.attributes) {
          if (attr.method === "middleware") groupCtx.middleware.push(...extractMiddlewareArg(attr.argsNode));
          if (attr.method === "prefix") groupCtx.prefix = extractFirstStringArg(attr.argsNode);
          if (attr.method === "controller") groupCtx.controller = extractClassArg(attr.argsNode);
        }
        const body = findClosureBody(chain.terminalArgs);
        if (body) {
          groupStack.push(groupCtx);
          walkChildren(body, groupStack);
          groupStack.pop();
        }
        return;
      }
      if (ROUTE_HTTP_METHODS.has(chain.terminalMethod) || ROUTE_RESOURCE_METHODS.has(chain.terminalMethod)) {
        emitRoute(chain.terminalMethod, chain.terminalArgs, node.startPosition.row, groupStack, chain.attributes);
        return;
      }
    }

    walkChildren(node, groupStack);
  }

  function walkChildren(node: any, groupStack: RouteGroupContext[]): void {
    for (const child of node.children ?? []) {
      walk(child, groupStack);
    }
  }

  walk(tree.rootNode, []);
  return routes;
}
