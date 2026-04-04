/**
 * Privacy verification tests
 * Requirements: 22.1, 22.2
 */
import { describe, it, expect } from "vitest";
import {
  containsSourceCode,
  verifyEmbeddingText,
  verifyEnrichmentPrompt,
  getPrivacyCompliance,
  EXTERNAL_DATA_POLICIES,
} from "./privacy.js";

describe("containsSourceCode", () => {
  it("returns false for symbol metadata", () => {
    const metadata = `function: getUserById
signature: (id: string) => Promise<User>
visibility: public
modifiers: async`;
    expect(containsSourceCode(metadata)).toBe(false);
  });

  it("returns false for cluster metadata", () => {
    const metadata = `cluster: Authentication Services
category: authentication
confidence: 0.92
symbols: function login, function logout, class AuthService`;
    expect(containsSourceCode(metadata)).toBe(false);
  });

  it("returns true for function definitions", () => {
    const code = `function getUserById(id: string) {
  return db.users.findOne({ id });
}`;
    expect(containsSourceCode(code)).toBe(true);
  });

  it("returns true for class definitions", () => {
    const code = `class UserService {
  constructor(private db: Database) {}
}`;
    expect(containsSourceCode(code)).toBe(true);
  });

  it("returns true for arrow functions", () => {
    const code = `const handler = (req, res) => {
  res.json({ ok: true });
}`;
    expect(containsSourceCode(code)).toBe(true);
  });

  it("returns true for if statements", () => {
    const code = `if (user.isAdmin) {
  return true;
}`;
    expect(containsSourceCode(code)).toBe(true);
  });

  it("returns true for import statements", () => {
    const code = `import { User } from './models/user';`;
    expect(containsSourceCode(code)).toBe(true);
  });

  it("returns true for require statements", () => {
    const code = `const express = require('express');`;
    expect(containsSourceCode(code)).toBe(true);
  });
});

describe("verifyEmbeddingText", () => {
  it("accepts symbol metadata without throwing", () => {
    const metadata = `function: processOrder
signature: (order: Order) => Promise<void>
visibility: public`;
    expect(() => verifyEmbeddingText(metadata, "processOrder")).not.toThrow();
  });

  it("accepts cluster metadata without throwing", () => {
    const metadata = `cluster: Order Processing
category: businessLogic
symbols: function processOrder, class OrderService`;
    expect(() => verifyEmbeddingText(metadata, "Order Processing")).not.toThrow();
  });

  it("throws when text contains function definitions", () => {
    const code = `function processOrder(order) {
  return order.total * 1.1;
}`;
    expect(() => verifyEmbeddingText(code, "processOrder")).toThrow(/Privacy violation/);
    expect(() => verifyEmbeddingText(code, "processOrder")).toThrow(/source code/);
  });

  it("throws when text contains file paths", () => {
    const text = `function: processOrder
file: /src/services/order-service.ts`;
    expect(() => verifyEmbeddingText(text, "processOrder")).toThrow(/Privacy violation/);
    expect(() => verifyEmbeddingText(text, "processOrder")).toThrow(/file paths/);
  });

  it("throws when text contains Windows file paths", () => {
    const text = `function: processOrder
file: C:\\src\\services\\order-service.ts`;
    expect(() => verifyEmbeddingText(text, "processOrder")).toThrow(/Privacy violation/);
  });
});

describe("verifyEnrichmentPrompt", () => {
  it("accepts prompts with only symbol names and kinds", () => {
    const prompt = `You are a software architect. Name this code cluster in 2–4 words.
Heuristic: "OrderProcessing"
Members: processOrder (function), OrderService (class), validateOrder (function)
Reply with ONLY the name, no punctuation.`;
    expect(() => verifyEnrichmentPrompt(prompt, "OrderProcessing")).not.toThrow();
  });

  it("throws when prompt contains function definitions", () => {
    const prompt = `Name this cluster:
function processOrder(order) {
  return order.total;
}`;
    expect(() => verifyEnrichmentPrompt(prompt, "test")).toThrow(/Privacy violation/);
    expect(() => verifyEnrichmentPrompt(prompt, "test")).toThrow(/source code/);
  });

  it("throws when prompt contains file paths", () => {
    const prompt = `Name this cluster from /src/services/order.ts`;
    expect(() => verifyEnrichmentPrompt(prompt, "test")).toThrow(/Privacy violation/);
    expect(() => verifyEnrichmentPrompt(prompt, "test")).toThrow(/file paths/);
  });
});

describe("getPrivacyCompliance", () => {
  it("returns correct compliance status", () => {
    const compliance = getPrivacyCompliance();
    
    expect(compliance.localProcessing).toBe(true);
    expect(compliance.verificationEnabled).toBe(true);
    expect(compliance.excludedData).toContain("full source code");
    expect(compliance.excludedData).toContain("file paths");
    expect(compliance.excludedData).toContain("implementation details");
  });

  it("includes correct embedding data types", () => {
    const compliance = getPrivacyCompliance();
    
    expect(compliance.embeddingDataTypes).toContain("symbol name");
    expect(compliance.embeddingDataTypes).toContain("symbol kind");
    expect(compliance.embeddingDataTypes).toContain("symbol signature");
  });

  it("includes correct enrichment data types", () => {
    const compliance = getPrivacyCompliance();
    
    expect(compliance.enrichmentDataTypes).toContain("heuristic cluster label");
    expect(compliance.enrichmentDataTypes).toContain("symbol names (max 20)");
    expect(compliance.enrichmentDataTypes).toContain("symbol kinds");
  });
});

describe("EXTERNAL_DATA_POLICIES", () => {
  it("defines policy for openai-embeddings", () => {
    const policy = EXTERNAL_DATA_POLICIES.find(p => p.service === "openai-embeddings");
    
    expect(policy).toBeDefined();
    expect(policy?.dataTypes).toContain("symbol name");
    expect(policy?.excludedData).toContain("full source code");
    expect(policy?.excludedData).toContain("file paths");
    expect(policy?.purpose).toContain("semantic embeddings");
  });

  it("defines policy for ai-enrichment", () => {
    const policy = EXTERNAL_DATA_POLICIES.find(p => p.service === "ai-enrichment");
    
    expect(policy).toBeDefined();
    expect(policy?.dataTypes).toContain("symbol names (max 20)");
    expect(policy?.excludedData).toContain("full source code");
    expect(policy?.excludedData).toContain("file paths");
    expect(policy?.purpose).toContain("cluster names");
  });

  it("ensures all policies exclude full source code", () => {
    for (const policy of EXTERNAL_DATA_POLICIES) {
      expect(policy.excludedData).toContain("full source code");
    }
  });

  it("ensures all policies exclude file paths", () => {
    for (const policy of EXTERNAL_DATA_POLICIES) {
      expect(policy.excludedData).toContain("file paths");
    }
  });
});
