import { describe, it, expect, vi } from "vitest";
import { parseArgs } from "./parser.js";
import * as fs from "fs";
import * as languageModule from "../../infrastructure/parsing/language.js";

vi.mock("fs");
vi.mock("../../infrastructure/parsing/language.js", async (importOriginal) => {
  const actual = await importOriginal<typeof languageModule>();
  return { ...actual, detectDirectoryLanguage: vi.fn() };
});

describe("parseArgs", () => {
  it("parses the parse command with explicit --lang", () => {
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
        refresh: false,
        incremental: true,
      },
    });
  });

  it("auto-detects language when --lang is omitted", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(languageModule.detectDirectoryLanguage).mockReturnValue("python");

    const args = ["node", "typocop", "parse", "-p", "./src"];
    const command = parseArgs(args);

    expect(command).toEqual({
      type: "parse",
      config: {
        sourcePath: "./src",
        language: "python",
        outputPath: undefined,
        verbose: false,
        refresh: false,
        incremental: true,
      },
    });
  });

  it("throws when --lang is omitted and detection fails", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(languageModule.detectDirectoryLanguage).mockReturnValue(null);

    const args = ["node", "typocop", "parse", "-p", "./src"];
    expect(() => parseArgs(args)).toThrow("Could not auto-detect language");
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

    expect(command).toEqual({ type: "status" });
  });

  it("parses the watch command with explicit --lang", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const args = ["node", "typocop", "watch", "-p", "./src", "-l", "typescript", "-v"];
    const command = parseArgs(args);

    expect(command).toEqual({
      type: "watch",
      config: {
        sourcePath: "./src",
        language: "typescript",
        verbose: true,
        incremental: true,
      },
    });
  });

  it("watch auto-detects language when --lang is omitted", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(languageModule.detectDirectoryLanguage).mockReturnValue("go");

    const args = ["node", "typocop", "watch", "-p", "./src"];
    const command = parseArgs(args);

    expect(command).toEqual({
      type: "watch",
      config: {
        sourcePath: "./src",
        language: "go",
        verbose: false,
        incremental: true,
      },
    });
  });

  it("watch throws for unsupported language", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const args = ["node", "typocop", "watch", "-p", "./src", "-l", "nope"];
    expect(() => parseArgs(args)).toThrow("Unsupported language 'nope'");
  });

  it("watch throws for non-existent source path", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const args = ["node", "typocop", "watch", "-p", "./invalid", "-l", "typescript"];
    expect(() => parseArgs(args)).toThrow("Source path does not exist: ./invalid");
  });

  it("parses the parse command with --refresh flag", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const args = ["node", "typocop", "parse", "-p", "./src", "-l", "typescript", "--refresh"];
    const command = parseArgs(args);

    expect(command).toEqual({
      type: "parse",
      config: {
        sourcePath: "./src",
        language: "typescript",
        outputPath: undefined,
        verbose: false,
        refresh: true,
        // --refresh is a clear-then-rebuild, which is inherently a full write.
        incremental: false,
      },
    });
  });

  it("parses the parse command with -r short form", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const args = ["node", "typocop", "parse", "-p", "./src", "-l", "typescript", "-r"];
    const command = parseArgs(args);

    expect(command).toEqual({
      type: "parse",
      config: {
        sourcePath: "./src",
        language: "typescript",
        outputPath: undefined,
        verbose: false,
        refresh: true,
        incremental: false,
      },
    });
  });

  it("defaults refresh to false when flag is omitted", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const args = ["node", "typocop", "parse", "-p", "./src", "-l", "typescript"];
    const command = parseArgs(args);

    expect(command).toEqual({
      type: "parse",
      config: {
        sourcePath: "./src",
        language: "typescript",
        outputPath: undefined,
        verbose: false,
        refresh: false,
        incremental: true,
      },
    });
  });

  it("defaults incremental to true when no flag is given (A4)", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const args = ["node", "typocop", "parse", "-p", "./src", "-l", "typescript"];
    const command = parseArgs(args);

    expect(command).toMatchObject({
      type: "parse",
      config: { incremental: true, refresh: false },
    });
  });

  it("disables incremental with --full (A4)", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const args = ["node", "typocop", "parse", "-p", "./src", "-l", "typescript", "--full"];
    const command = parseArgs(args);

    expect(command).toMatchObject({
      type: "parse",
      config: { incremental: false, refresh: false },
    });
  });

  it("--full overrides --incremental (A4)", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const args = ["node", "typocop", "parse", "-p", "./src", "-l", "typescript", "--incremental", "--full"];
    const command = parseArgs(args);

    expect(command).toMatchObject({
      type: "parse",
      config: { incremental: false },
    });
  });

  it("help text includes refresh option", () => {
    // Capture stdout to verify help text
    let helpOutput = "";
    const originalWrite = process.stdout.write;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      helpOutput += chunk.toString();
      return true;
    });

    try {
      const args = ["node", "typocop", "parse", "--help"];
      parseArgs(args);
    } catch (error) {
      // --help causes the program to exit, which is expected
    }

    process.stdout.write = originalWrite;

    // Verify help text contains refresh option
    expect(helpOutput).toContain("--refresh");
    expect(helpOutput).toContain("-r");
    expect(helpOutput).toContain("Clear and rebuild all graph and embeddings data");
  });
});
