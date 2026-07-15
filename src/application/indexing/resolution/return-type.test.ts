/**
 * Wave 3 (Tier B) Task 2 — down-payment `extractReturnTypeName` unit tests.
 *
 * Every WRAPPER_GENERICS case + Go pointer + Rust ref + nullable-union, plus the
 * refusals (genuine union / primitive / bare wrapper). (§7 down-payment tests.)
 */
import { describe, expect, it } from "vitest";
import {
  extractReturnTypeName, extractFirstGenericArg, extractFirstTypeArg,
} from "./return-type.js";

describe("extractReturnTypeName — wrapper generics unwrap to inner type", () => {
  it.each([
    ["Promise<User>", "User"],
    ["Observable<User>", "User"],
    ["Future<User>", "User"],
    ["CompletableFuture<User>", "User"],
    ["Task<User>", "User"],
    ["ValueTask<User>", "User"],
    ["Option<User>", "User"],
    ["Optional<User>", "User"],
    ["Maybe<User>", "User"],
    ["Some<User>", "User"],
    ["Result<User, Error>", "User"],
    ["Either<User, Error>", "User"],
    ["Rc<User>", "User"],
    ["Arc<User>", "User"],
    ["Weak<User>", "User"],
    ["MutexGuard<User>", "User"],
    ["RwLockReadGuard<User>", "User"],
    ["RwLockWriteGuard<User>", "User"],
    ["Ref<User>", "User"],
    ["RefMut<User>", "User"],
    ["Cow<User>", "User"],
    // Nested: Promise<Result<User, E>> → User
    ["Promise<Result<User, Error>>", "User"],
  ])("%s → %s", (input, expected) => {
    expect(extractReturnTypeName(input)).toBe(expected);
  });
});

describe("extractReturnTypeName — pointers / references / nullable", () => {
  it.each([
    ["*User", "User"], // Go pointer
    ["&User", "User"], // Rust reference
    ["&mut User", "User"], // Rust mutable reference
    ["User?", "User"], // nullable suffix
    ["User | null", "User"], // nullable union
    ["User | undefined", "User"],
    ["models.User", "User"], // qualified dotted
    ["Models::User", "User"], // qualified ::
    ["\\App\\Models\\User", "User"], // PHP namespaced
  ])("%s → %s", (input, expected) => {
    expect(extractReturnTypeName(input)).toBe(expected);
  });
});

describe("extractReturnTypeName — non-wrapper generic returns the base", () => {
  it("Map<K, V> → Map (container, not wrapper)", () => {
    expect(extractReturnTypeName("Map<K, V>")).toBe("Map");
  });
  it("List<User> → List", () => {
    expect(extractReturnTypeName("List<User>")).toBe("List");
  });
});

describe("extractReturnTypeName — refusals (precision)", () => {
  it.each([
    ["User | Order"], // genuine union
    ["number"], // primitive
    ["string"], // primitive
    ["void"], // primitive
    ["Promise"], // bare wrapper, no arg
    ["Task"], // bare wrapper, no arg
    ["Option"], // bare wrapper, no arg
    [""], // empty
    ["lowercaseThing"], // not class-cased (starts lowercase)
  ])("%s → undefined", (input) => {
    expect(extractReturnTypeName(input)).toBeUndefined();
  });
});

describe("extractFirstGenericArg / extractFirstTypeArg", () => {
  it("respects nested angle brackets", () => {
    expect(extractFirstGenericArg("User, Error")).toBe("User");
    expect(extractFirstGenericArg("Map<K, V>, string")).toBe("Map<K, V>");
    expect(extractFirstGenericArg("Result<User, Error>")).toBe("Result<User, Error>");
  });
  it("skips Rust lifetime parameters", () => {
    expect(extractFirstTypeArg("'_, User")).toBe("User");
    expect(extractFirstTypeArg("'a, User")).toBe("User");
    expect(extractFirstTypeArg("User, Error")).toBe("User");
  });
});
