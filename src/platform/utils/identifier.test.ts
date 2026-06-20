import { describe, it, expect } from "vitest";
import { splitIdentifier } from "./identifier.js";

describe("splitIdentifier", () => {
  it("splits camelCase", () => {
    expect(splitIdentifier("getUserById")).toEqual(["get", "user", "by", "id"]);
  });

  it("splits PascalCase", () => {
    expect(splitIdentifier("UserService")).toEqual(["user", "service"]);
  });

  it("splits acronym boundaries (XMLParser → xml parser)", () => {
    expect(splitIdentifier("XMLParser")).toEqual(["xml", "parser"]);
  });

  it("splits snake_case and kebab-case", () => {
    expect(splitIdentifier("user_repo-v2")).toEqual(["user", "repo", "v2"]);
  });

  it("drops single-character parts", () => {
    expect(splitIdentifier("aB")).toEqual([]);
    expect(splitIdentifier("xRay")).toEqual(["ray"]);
  });

  it("returns an empty array for an empty string", () => {
    expect(splitIdentifier("")).toEqual([]);
  });
});
