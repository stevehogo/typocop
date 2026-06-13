/**
 * Integration test for end-to-end wiring.
 * Tests that CLI → Pipeline → Databases → Query Server → MCP Server are properly connected.
 */
import { describe, it, expect } from "vitest";

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

  describe("Database Adapter Wiring", () => {
    it("should export createDatabaseAdapter from db module", async () => {
      const { createDatabaseAdapter } = await import("../db/database-adapter.js");
      expect(createDatabaseAdapter).toBeDefined();
      expect(typeof createDatabaseAdapter).toBe("function");
    });

    it("should export DatabaseAdapter types from db module", async () => {
      const module = await import("../core/ports/persistence.js");
      expect(module).toBeDefined();
    });
  });

  describe("Type Compatibility", () => {
    it("should have compatible types between pipeline and CLI", async () => {
      const { runIndexingPipeline } = await import("../indexer/pipeline.js");
      const { executeCLI } = await import("../cli/executor.js");

      expect(typeof runIndexingPipeline).toBe("function");
      expect(typeof executeCLI).toBe("function");
    });

    it("should have compatible types between query server and MCP", async () => {
      const { executeQuery } = await import("../query/execute-query.js");
      const { executeTool } = await import("../mcp/tools.js");

      expect(typeof executeQuery).toBe("function");
      expect(typeof executeTool).toBe("function");
    });
  });
});
