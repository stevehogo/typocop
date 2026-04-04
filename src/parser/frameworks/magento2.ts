/**
 * Magento 2 framework-specific parser.
 * Requirements: 14.1, 14.9
 */
import type { Symbol, FrameworkSupport } from "../../types/index.js";
import { extractSymbols } from "../extract-symbols.js";
import { fromSyntaxNode } from "../ast-node.js";
import path from "path";
import fs from "fs/promises";
import Parser from "tree-sitter";
import PHP from "tree-sitter-php";

export const MAGENTO2_SUPPORT: FrameworkSupport = {
  framework: "Magento 2",
  language: "php",
  apiEndpoints: true,
  controllers: true,
  dbModels: true,
  supportedORMs: ["Magento ORM"],
  tracingLevel: "full",
};

/**
 * Parse Magento 2 webapi.xml to extract REST/GraphQL endpoints.
 * Requirement: 14.1
 */
export async function parseWebapiXml(xmlPath: string): Promise<Symbol[]> {
  try {
    const content = await fs.readFile(xmlPath, "utf-8");
    const symbols: Symbol[] = [];
    
    // Extract route patterns: <route url="/V1/customers/:id" method="GET">
    const routePattern = /<route\s+url="([^"]+)"\s+method="([^"]+)"/g;
    let match;
    
    while ((match = routePattern.exec(content)) !== null) {
      const [, url, method] = match;
      symbols.push({
        id: `magento2:api:${method}:${url}`,
        name: `${method} ${url}`,
        kind: "function",
        location: {
          filePath: xmlPath,
          startLine: 0,
          startColumn: 0,
          endLine: 0,
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
 * Parse Magento 2 Controller/Action classes.
 * Requirement: 14.1
 */
export async function parseControllerAction(filePath: string, parser: Parser): Promise<Symbol[]> {
  if (!filePath.includes("/Controller/")) return [];
  
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const tree = parser.parse(content);
    const ast = fromSyntaxNode(tree.rootNode);
    const symbols = extractSymbols(ast, filePath);
    
    // Mark execute() methods as entry points
    return symbols.map((s: Symbol) => 
      s.name === "execute" && s.kind === "method"
        ? { ...s, modifiers: [...s.modifiers, "async"] }
        : s
    );
  } catch {
    return [];
  }
}

/**
 * Parse Magento 2 Model/ResourceModel/Collection pattern.
 * Requirement: 14.1
 */
export async function parseModelPattern(filePath: string, parser: Parser): Promise<Symbol[]> {
  const isModel = filePath.includes("/Model/") && 
                  !filePath.includes("/ResourceModel/");
  const isResourceModel = filePath.includes("/Model/ResourceModel/");
  
  if (!isModel && !isResourceModel) return [];
  
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const tree = parser.parse(content);
    const ast = fromSyntaxNode(tree.rootNode);
    return extractSymbols(ast, filePath);
  } catch {
    return [];
  }
}

/**
 * Parse Magento 2 Repository interfaces and implementations.
 * Requirement: 14.1
 */
export async function parseRepository(filePath: string, parser: Parser): Promise<Symbol[]> {
  if (!filePath.includes("Repository")) return [];
  
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const tree = parser.parse(content);
    const ast = fromSyntaxNode(tree.rootNode);
    return extractSymbols(ast, filePath);
  } catch {
    return [];
  }
}

/**
 * Parse Magento 2 Plugin (interceptor) methods.
 * Requirement: 14.1
 */
export async function parsePlugin(filePath: string, parser: Parser): Promise<Symbol[]> {
  if (!filePath.includes("/Plugin/")) return [];
  
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const tree = parser.parse(content);
    const ast = fromSyntaxNode(tree.rootNode);
    const symbols = extractSymbols(ast, filePath);
    
    // Identify before/after/around methods
    return symbols.filter((s: Symbol) => 
      s.kind === "method" && 
      (s.name.startsWith("before") || s.name.startsWith("after") || s.name.startsWith("around"))
    );
  } catch {
    return [];
  }
}

/**
 * Parse Magento 2 events.xml for Observer registrations.
 * Requirement: 14.1
 */
export async function parseEventsXml(xmlPath: string): Promise<Symbol[]> {
  try {
    const content = await fs.readFile(xmlPath, "utf-8");
    const symbols: Symbol[] = [];
    
    // Extract event observers: <event name="customer_save_after">
    const eventPattern = /<event\s+name="([^"]+)"/g;
    let match;
    
    while ((match = eventPattern.exec(content)) !== null) {
      const [, eventName] = match;
      symbols.push({
        id: `magento2:event:${eventName}`,
        name: eventName,
        kind: "function",
        location: {
          filePath: xmlPath,
          startLine: 0,
          startColumn: 0,
          endLine: 0,
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
 * Parse Magento 2 di.xml for dependency injection configuration.
 * Requirement: 14.1
 */
export async function parseDiXml(xmlPath: string): Promise<Symbol[]> {
  try {
    const content = await fs.readFile(xmlPath, "utf-8");
    const symbols: Symbol[] = [];
    
    // Extract preferences: <preference for="Interface" type="Implementation" />
    const prefPattern = /<preference\s+for="([^"]+)"\s+type="([^"]+)"/g;
    let match;
    
    while ((match = prefPattern.exec(content)) !== null) {
      const [, forType, implType] = match;
      symbols.push({
        id: `magento2:di:${forType}`,
        name: `${forType} → ${implType}`,
        kind: "type",
        location: {
          filePath: xmlPath,
          startLine: 0,
          startColumn: 0,
          endLine: 0,
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
 * Main entry point for Magento 2 parsing.
 * Orchestrates all Magento 2-specific parsers.
 */
export async function parseMagento2File(filePath: string): Promise<Symbol[]> {
  const ext = path.extname(filePath);
  
  if (ext === ".xml") {
    const basename = path.basename(filePath);
    if (basename === "webapi.xml") return parseWebapiXml(filePath);
    if (basename === "events.xml") return parseEventsXml(filePath);
    if (basename === "di.xml") return parseDiXml(filePath);
    return [];
  }
  
  if (ext === ".php") {
    const parser = new Parser();
    parser.setLanguage(PHP.php as unknown as Parser.Language);
    
    const results = await Promise.all([
      parseControllerAction(filePath, parser),
      parseModelPattern(filePath, parser),
      parseRepository(filePath, parser),
      parsePlugin(filePath, parser),
    ]);
    return results.flat();
  }
  
  return [];
}
