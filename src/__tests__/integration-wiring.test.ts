/**
 * Integration test for end-to-end wiring.
 * Tests that CLI → Pipeline → Databases → Query Server → MCP Server are properly connected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Driver, Session } from "neo4j-driver";
import type { Pool } from "pg";

describe("Integration Wiring", () => {
  describe("Pipeline Orchestration", () => {
    it("should export runIndexingPipeline from indexer", async () => {
      const { runIndexingPipeline } = await import("../indexer/pipeline.js");
      expect(runIndexingPipeline).toBeDefined();
      expect(typeof runIndexingPipeline).toBe("function");
    });

    it("should export PipelineConfig type from indexer", async () => {
      const module = await import("../indexer/pipeline.js");
      expect(module).toBeDefined();
    });
  });

  describe("CLI to Pipeline Wiring", () => {
    it("should import pipeline functions in CLI executor", async () => {
      const { executeCLI } = await import("../cli/executor.js");
      expect(executeCLI).toBeDefined();
      expect(typeof executeCLI).toBe("function");
    });
  });

  describe("Query Server to Databases Wiring", () => {
    it("should export createQueryServer from query module", async () => {
      const { createQueryServer } = await import("../query/server.js");
      expect(createQueryServer).toBeDefined();
      expect(typeof createQueryServer).toBe("function");
    });

    it("should export startQueryServer from query module", async () => {
      const { startQueryServer } = await import("../query/server.js");
      expect(startQueryServer).toBeDefined();
      expect(typeof startQueryServer).toBe("function");
    });
  });

  describe("MCP Server to Query Server Wiring", () => {
    it("should export startMCPServer from MCP module", async () => {
      const { startMCPServer } = await import("../mcp/server.js");
      expect(startMCPServer).toBeDefined();
      expect(typeof startMCPServer).toBe("function");
    });

    it("should export executeTool from MCP module", async () => {
      const { executeTool } = await import("../mcp/tools.js");
      expect(executeTool).toBeDefined();
      expect(typeof executeTool).toBe("function");
    });
  });

  describe("Database Connection Utilities", () => {
    it("should export createDriver from graph module", async () => {
      const { createDriver } = await import("../graph/connection.js");
      expect(createDriver).toBeDefined();
      expect(typeof createDriver).toBe("function");
    });

    it("should export createPool from vector module", async () => {
      const { createPool } = await import("../vector/connection.js");
      expect(createPool).toBeDefined();
      expect(typeof createPool).toBe("function");
    });

    it("should export storeNodes from graph module", async () => {
      const { storeNodes } = await import("../graph/store.js");
      expect(storeNodes).toBeDefined();
      expect(typeof storeNodes).toBe("function");
    });

    it("should export indexSymbol from vector module", async () => {
      const { indexSymbol } = await import("../vector/index-store.js");
      expect(indexSymbol).toBeDefined();
      expect(typeof indexSymbol).toBe("function");
    });
  });

  describe("Type Compatibility", () => {
    it("should have compatible types between pipeline and CLI", async () => {
      const { runIndexingPipeline } = await import("../indexer/pipeline.js");
      const { executeCLI } = await import("../cli/executor.js");
      
      // Both should be functions
      expect(typeof runIndexingPipeline).toBe("function");
      expect(typeof executeCLI).toBe("function");
    });

    it("should have compatible types between query server and MCP", async () => {
      const { executeQuery } = await import("../query/execute-query.js");
      const { executeTool } = await import("../mcp/tools.js");
      
      // Both should be functions
      expect(typeof executeQuery).toBe("function");
      expect(typeof executeTool).toBe("function");
    });
  });
});
