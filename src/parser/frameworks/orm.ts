/**
 * Shared ORM parsers for Express/Fastify.
 * Requirements: 14.4, 14.5
 */
import type { Symbol } from "../../types/index.js";
import { extractSymbols } from "../extract-symbols.js";
import { fromSyntaxNode } from "../ast-node.js";
import fs from "fs/promises";
import Parser from "tree-sitter";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const TypeScript = require("tree-sitter-typescript") as {
  typescript: Parser.Language;
  tsx: Parser.Language;
};

/**
 * Parse Mongoose schema definitions.
 */
export async function parseMongooseSchemas(filePath: string, parser: Parser): Promise<Symbol[]> {
  if (!filePath.includes("model") && !filePath.includes("schema")) return [];
  
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const tree = parser.parse(content);
    const ast = fromSyntaxNode(tree.rootNode);
    const symbols = extractSymbols(ast, filePath);
    
    // Filter for mongoose.model or new Schema
    return symbols.filter((s: Symbol) => 
      s.signature && 
      (s.signature.includes("mongoose.model") || s.signature.includes("new Schema"))
    );
  } catch {
    return [];
  }
}

/**
 * Parse ORM models for Express/Fastify projects.
 */
export async function parseORMModels(filePath: string): Promise<Symbol[]> {
  // Prisma models handled by NestJS parser (schema.prisma)
  if (filePath.endsWith("schema.prisma")) {
    const { parsePrismaModels } = await import("./nestjs.js");
    return parsePrismaModels(filePath);
  }
  
  // TypeORM entities
  if (filePath.endsWith(".entity.ts")) {
    const { parseTypeORMEntities } = await import("./nestjs.js");
    const parser = new Parser();
    parser.setLanguage(TypeScript.typescript as unknown as Parser.Language);
    return parseTypeORMEntities(filePath, parser);
  }
  
  // Mongoose schemas
  if (filePath.includes("model") || filePath.includes("schema")) {
    const parser = new Parser();
    parser.setLanguage(TypeScript.typescript as unknown as Parser.Language);
    return parseMongooseSchemas(filePath, parser);
  }
  
  return [];
}
