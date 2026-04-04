import { describe, it, expect, vi } from "vitest";
import { parseArgs } from "./parser.js";
import * as fs from "fs";

vi.mock("fs");

describe("parseArgs", () => {
  it("parses the parse command with valid arguments", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const args = ["node", "typocop", "parse", "-p", "./src", "-l", "typescript", "-v"];
    const command = parseArgs(args);

    expect(command).toEqual({
      type: "parse",
      config: {
        sourcePath: "./src",
        language: "typescript",
        outputPath: undefined,
        verbose: true,
      },
    });
  });

  it("throws error for unsupported language", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const args = ["node", "typocop", "parse", "-p", "./src", "-l", "unsupported"];
    expect(() => parseArgs(args)).toThrow("Unsupported language 'unsupported'");
  });

  it("throws error for non-existent source path", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const args = ["node", "typocop", "parse", "-p", "./invalid", "-l", "typescript"];
    expect(() => parseArgs(args)).toThrow("Source path does not exist: ./invalid");
  });

  it("parses the reindex command", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const args = ["node", "typocop", "reindex", "-d", "./db"];
    const command = parseArgs(args);
    
    expect(command).toEqual({
      type: "reindex",
      dbPath: "./db",
    });
  });

  it("parses the status command", () => {
    const args = ["node", "typocop", "status"];
    const command = parseArgs(args);
    
    expect(command).toEqual({
      type: "status",
    });
  });

  it("throws error when missing required options", () => {
    const args = ["node", "typocop", "parse", "-p", "./src"];
    expect(() => parseArgs(args)).toThrow(); // Should throw commander error for missing -l
  });
});
