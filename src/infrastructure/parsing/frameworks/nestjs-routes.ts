/**
 * Wave 6 — NestJS route extractor (decorator walk, with handler linkage).
 *
 * Walks a TypeScript tree-sitter tree, finds `@Controller('prefix')` classes and
 * their `@Get|@Post|...` decorated methods, and emits structured
 * {@link ExtractedRoute}s. Each route carries a `handlerNodeId` produced with
 * typocop's {@link generateLogicalKey} (NOT the legacy id helper) so Wave 5 can
 * match the route to the persisted Method node without re-resolution.
 *
 * Operates on the ALREADY-PARSED tree (no second `fs.readFile`, no new `Parser`).
 * Raw tree-sitter node access is intentional (`childForFieldName` /
 * `child(i)` / `startPosition.row`) — `findDecoratorBackward` + the nested
 * decorator scan handle grammar-version drift in where `decorator` nodes sit.
 *
 * Provenance: ported from the legacy parser (typocop's pre-refactor parser
 * lineage). Nodes are tree-sitter raw nodes, hence `any`-typed.
 */
import type { ExtractedRoute } from "./extracted-records.js";
import { generateLogicalKey } from "../logical-key.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** NestJS HTTP-method decorators → HTTP verbs. */
export const NESTJS_ROUTE_DECORATORS: Record<string, string> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Patch: "PATCH",
  Delete: "DELETE",
  Options: "OPTIONS",
  Head: "HEAD",
  All: "ALL",
};

const NESTJS_CONTROLLER_NAMES = new Set(["Controller", "RestController"]);

/**
 * Parse a `decorator` node's text → `{ name, firstArg }`.
 * Handles `@Get('path')`, `@Get()`, `@Get`, `@Controller('prefix')`.
 */
export function parseDecoratorText(decoratorNode: any): { name: string; firstArg: string | null } | null {
  const text: string = decoratorNode.text || "";
  const match = text.match(/@(\w+)\s*(?:\(\s*['"]([^'"]*)['"]\s*\)|\(\s*\))?/);
  if (!match) return null;
  return { name: match[1], firstArg: match[2] ?? null };
}

/**
 * Walk backwards over preceding siblings (from `startIdx-1`) and return the first
 * `decorator` matching `matchFn`.
 *
 * @param contiguous when `true` (default — used for method route decorators that
 *   sit directly before their `method_definition` in `class_body`), stop at the
 *   first non-decorator sibling. When `false` (used for a `@Controller` on a
 *   class inside an `export_statement`, where the `export` keyword sits between
 *   the decorator and the class in typocop's grammar), skip non-decorator
 *   siblings instead of stopping. Single-class scope means no cross-class bleed.
 */
export function findDecoratorBackward(
  parentNode: any,
  startIdx: number,
  matchFn: (name: string) => boolean,
  contiguous: boolean = true,
): { name: string; firstArg: string | null } | null {
  for (let i = startIdx - 1; i >= 0; i--) {
    const sib = parentNode.child(i);
    if (!sib) break;
    if (sib.type !== "decorator") {
      if (contiguous) break;
      continue;
    }
    const info = parseDecoratorText(sib);
    if (info && matchFn(info.name)) return info;
  }
  return null;
}

/** Walk the tree and emit structured NestJS routes with handler linkage. */
export function extractNestJSRoutes(tree: any, filePath: string): ExtractedRoute[] {
  const routes: ExtractedRoute[] = [];

  function processClassDeclaration(classNode: any, classIdx: number, classParent: any): void {
    // 1. Controller prefix from a sibling @Controller decorator…
    let controllerPrefix: string | null = null;
    const controllerDec = findDecoratorBackward(
      classParent,
      classIdx,
      (name) => NESTJS_CONTROLLER_NAMES.has(name),
      // non-contiguous: skip the `export` keyword between the decorator and class.
      false,
    );

    if (controllerDec) {
      controllerPrefix = controllerDec.firstArg || "";
    } else {
      // …or a nested decorator child (grammar-version fallback).
      for (let i = 0; i < classNode.childCount; i++) {
        const child = classNode.child(i);
        if (child?.type === "decorator") {
          const info = parseDecoratorText(child);
          if (info && NESTJS_CONTROLLER_NAMES.has(info.name)) {
            controllerPrefix = info.firstArg || "";
            break;
          }
        }
      }
    }

    // Not a controller class → last resort: derive from filename, else skip.
    if (controllerPrefix === null) {
      const nameNode = classNode.childForFieldName?.("name");
      const className = nameNode?.text || "";
      if (className.endsWith("Controller")) {
        const fileBase = filePath.match(/([^/\\]+)\.controller\./i);
        controllerPrefix = fileBase ? fileBase[1] : "";
      } else {
        return;
      }
    }

    const nameNode = classNode.childForFieldName?.("name");
    const className = nameNode?.text || "";

    // 2. Each route-decorated method in the class body.
    const body = classNode.childForFieldName?.("body");
    if (!body) return;

    for (let mi = 0; mi < body.childCount; mi++) {
      const child = body.child(mi);
      if (!child || child.type !== "method_definition") continue;

      const routeDec = findDecoratorBackward(body, mi, (name) => name in NESTJS_ROUTE_DECORATORS);
      if (!routeDec) continue;

      const methodName = child.childForFieldName?.("name")?.text || "";
      routes.push({
        filePath,
        httpMethod: NESTJS_ROUTE_DECORATORS[routeDec.name],
        routePath: routeDec.firstArg,
        controllerName: className,
        methodName,
        middleware: [],
        prefix: controllerPrefix,
        lineNumber: child.startPosition.row,
        // typocop persisted Method-node identity (NOT the legacy id helper).
        handlerNodeId: generateLogicalKey(filePath, methodName, "method"),
      });
    }
  }

  function walk(node: any): void {
    for (let i = 0; i < (node.childCount ?? 0); i++) {
      const child = node.child(i);
      if (!child) continue;

      if (child.type === "class_declaration") {
        processClassDeclaration(child, i, node);
      } else if (child.type === "export_statement") {
        for (let j = 0; j < child.childCount; j++) {
          const inner = child.child(j);
          if (inner?.type === "class_declaration") {
            processClassDeclaration(inner, j, child);
          }
        }
      } else {
        walk(child);
      }
    }
  }

  walk(tree.rootNode);
  return routes;
}
