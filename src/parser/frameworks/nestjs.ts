/**
 * NestJS framework-specific parser.
 * Requirements: 14.2, 14.9
 */
import type { Symbol, FrameworkSupport } from "../../types/index.js";
import { extractSymbols } from "../extract-symbols.js";
import { fromSyntaxNode } from "../ast-node.js";
import path from "path";
import fs from "fs/promises";
import Parser from "tree-sitter";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const TypeScript = require("tree-sitter-typescript") as {
  typescript: Parser.Language;
  tsx: Parser.Language;
};

export const NESTJS_SUPPORT: FrameworkSupport = {
  framework: "NestJS",
  language: "typescript",
  apiEndpoints: true,
  controllers: true,
  dbModels: true,
  supportedORMs: ["Prisma", "TypeORM"],
  tracingLevel: "full",
};

/**
 * Parse NestJS route decorators (@Get, @Post, @Put, @Delete, @Patch).
 * Requirement: 14.2
 */
export async function parseRouteDecorators(filePath: string, parser: Parser): Promise<Symbol[]> {
  if (!filePath.includes(".controller.")) return [];
  
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const tree = parser.parse(content);
    const ast = fromSyntaxNode(tree.rootNode);
    const symbols = extractSymbols(ast, filePath);
    
    // Filter for methods with route decorators
    const routePattern = /@(Get|Post|Put|Delete|Patch|All)\s*\(/;
    return symbols.filter((s: Symbol) => 
      s.kind === "method" && 
      s.signature && 
      routePattern.test(s.signature)
    );
  } catch {
    return [];
  }
}

/**
 * Parse NestJS dependency injection patterns.
 * Requirement: 14.2
 */
export async function parseDependencyInjection(filePath: string, parser: Parser): Promise<Symbol[]> {
  if (!filePath.endsWith(".service.ts") && !filePath.endsWith(".controller.ts")) return [];
  
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const tree = parser.parse(content);
    const ast = fromSyntaxNode(tree.rootNode);
    const symbols = extractSymbols(ast, filePath);
    
    // Filter for classes with @Injectable decorator
    return symbols.filter((s: Symbol) => 
      s.kind === "class" && 
      s.signature && 
      s.signature.includes("@Injectable")
    );
  } catch {
    return [];
  }
}

/**
 * Parse Prisma model definitions.
 * Requirement: 14.2
 */
export async function parsePrismaModels(filePath: string): Promise<Symbol[]> {
  if (!filePath.endsWith("schema.prisma")) return [];
  
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const symbols: Symbol[] = [];
    
    // Extract model definitions: model User {
    const modelPattern = /model\s+(\w+)\s*\{/g;
    let match;
    
    while ((match = modelPattern.exec(content)) !== null) {
      const [, modelName] = match;
      const lineNumber = content.substring(0, match.index).split("\n").length;
      
      symbols.push({
        id: `nestjs:prisma:${modelName}`,
        name: modelName,
        kind: "class",
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
 * Parse TypeORM entity definitions.
 * Requirement: 14.2
 */
export async function parseTypeORMEntities(filePath: string, parser: Parser): Promise<Symbol[]> {
  if (!filePath.endsWith(".entity.ts")) return [];
  
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const tree = parser.parse(content);
    const ast = fromSyntaxNode(tree.rootNode);
    const symbols = extractSymbols(ast, filePath);
    
    // Filter for classes with @Entity decorator
    return symbols.filter((s: Symbol) => 
      s.kind === "class" && 
      s.signature && 
      s.signature.includes("@Entity")
    );
  } catch {
    return [];
  }
}

/**
 * Main entry point for NestJS parsing.
 * Orchestrates all NestJS-specific parsers.
 */
export async function parseNestJSFile(filePath: string): Promise<Symbol[]> {
  const ext = path.extname(filePath);
  
  // Handle Prisma schema files
  if (filePath.endsWith("schema.prisma")) {
    return parsePrismaModels(filePath);
  }
  
  // Handle TypeScript files
  if (ext === ".ts" || ext === ".tsx") {
    const parser = new Parser();
    const grammar = ext === ".tsx" ? TypeScript.tsx : TypeScript.typescript;
    parser.setLanguage(grammar as unknown as Parser.Language);
    
    const results = await Promise.all([
      parseRouteDecorators(filePath, parser),
      parseDependencyInjection(filePath, parser),
      parseTypeORMEntities(filePath, parser),
    ]);
    return results.flat();
  }
  
  return [];
}
