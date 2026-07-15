/**
 * Return-type-text unwrapper (Wave 3, Tier B — Task 2 down-payment).
 *
 * Ported from the legacy parser (typocop's pre-refactor parser lineage). Operates
 * on the raw return-type TEXT already stored on `Symbol.returnType` /
 * `SymbolDefinition.returnType` (the complement of the AST-node `extractSimpleTypeName`).
 * It strengthens chain-binding's single-generic `bareTypeName`: it distinguishes
 * a wrapper generic (`Promise<User>`→`User`) from a container (`List<User>`→`List`),
 * unwraps Go pointers / Rust references / nullable unions, and returns `undefined`
 * for genuine unions / primitives / bare wrappers.
 *
 * Standalone + pure — no env, no AST, no domain types. Used behind the Tier-B
 * flag; the byte-for-byte fallback is the original `bareTypeName`.
 */

/** Primitive / built-in types that should NOT produce a receiver binding. */
const PRIMITIVE_TYPES: ReadonlySet<string> = new Set([
  "string", "number", "boolean", "void", "int", "float", "double", "long",
  "short", "byte", "char", "bool", "str", "i8", "i16", "i32", "i64",
  "u8", "u16", "u32", "u64", "f32", "f64", "usize", "isize",
  "undefined", "null", "None", "nil",
]);

/**
 * Generic wrappers that DEREF to their inner type (so `Promise<User>` calls
 * resolve to `User`'s methods). Containers (List/Vec/Set/…) are intentionally
 * EXCLUDED — methods are called on the container, not the element, so a non-wrapper
 * generic returns the base type via the else branch.
 */
const WRAPPER_GENERICS: ReadonlySet<string> = new Set([
  "Promise", "Observable", "Future", "CompletableFuture", "Task", "ValueTask", // async wrappers
  "Option", "Some", "Optional", "Maybe", // nullable wrappers
  "Result", "Either", // result wrappers
  "Rc", "Arc", "Weak", // Rust smart pointers
  "MutexGuard", "RwLockReadGuard", "RwLockWriteGuard", // guard types
  "Ref", "RefMut", // RefCell guards
  "Cow", // copy-on-write
]);

/**
 * Extract the first type argument from a comma-separated generic argument string,
 * respecting nested angle brackets. `"Result<User, Error>"`→whole (no top-level
 * comma); `"User, Error"`→`"User"`; `"Map<K, V>, string"`→`"Map<K, V>"`.
 */
export function extractFirstGenericArg(args: string): string {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "<") depth++;
    else if (args[i] === ">") depth--;
    else if (args[i] === "," && depth === 0) return args.slice(0, i).trim();
  }
  return args.trim();
}

/**
 * Extract the first non-lifetime type argument, skipping Rust lifetimes (`'a`,
 * `'_`). `"'_, User"`→`"User"`; `"'a, User"`→`"User"`.
 */
export function extractFirstTypeArg(args: string): string {
  let remaining = args;
  while (remaining) {
    const first = extractFirstGenericArg(remaining);
    if (!first.startsWith("'")) return first;
    const commaIdx = remaining.indexOf(",", first.length);
    if (commaIdx < 0) return first; // only lifetimes — fall through
    remaining = remaining.slice(commaIdx + 1).trim();
  }
  return args.trim();
}

/**
 * Extract a simple user-defined type name from raw return-type text, or
 * `undefined` for complex types/primitives/genuine unions/bare wrappers.
 *
 *   "User"                → "User"
 *   "Promise<User>"       → "User"   (unwrap wrapper generic)
 *   "Option<User>"        → "User"
 *   "Result<User, Error>" → "User"   (first type arg)
 *   "Map<K, V>"           → "Map"    (non-wrapper generic → base)
 *   "User | null"         → "User"   (strip nullable union)
 *   "User?"               → "User"   (strip nullable suffix)
 *   "*User" / "&User"     → "User"   (Go pointer / Rust reference)
 *   "User | Order"        → undefined (genuine union)
 *   "Promise"             → undefined (bare wrapper)
 *   "number"              → undefined (primitive)
 */
export const extractReturnTypeName = (raw: string): string | undefined => {
  let text = raw.trim();
  if (!text) return undefined;

  // Strip pointer/reference prefixes: *User, &User, &mut User.
  text = text.replace(/^[&*]+\s*(mut\s+)?/, "");

  // Strip nullable suffix: User?.
  text = text.replace(/\?$/, "");

  // Union types: "User | null" → "User"; genuine unions → undefined.
  if (text.includes("|")) {
    const parts = text.split("|").map((p) => p.trim()).filter(
      (p) => p !== "null" && p !== "undefined" && p !== "void" && p !== "None" && p !== "nil",
    );
    if (parts.length === 1) text = parts[0];
    else return undefined; // genuine union — too complex
  }

  // Generics: Promise<User> → unwrap if wrapper, else take base.
  const genericMatch = text.match(/^(\w+)\s*<(.+)>$/);
  if (genericMatch) {
    const [, base, args] = genericMatch;
    if (WRAPPER_GENERICS.has(base)) {
      const firstArg = extractFirstTypeArg(args);
      return extractReturnTypeName(firstArg);
    }
    return PRIMITIVE_TYPES.has(base.toLowerCase()) ? undefined : base;
  }

  // Bare wrapper without a generic arg (Task, Promise, Option) → no binding.
  if (WRAPPER_GENERICS.has(text)) return undefined;

  // Qualified names: models.User → User, Models::User → User, \App\Models\User → User.
  if (text.includes("::") || text.includes(".") || text.includes("\\")) {
    text = text.split(/::|[.\\]/).pop()!;
  }

  // Skip primitives.
  if (PRIMITIVE_TYPES.has(text) || PRIMITIVE_TYPES.has(text.toLowerCase())) return undefined;

  // Must start uppercase/underscore (class/type convention).
  if (!/^[A-Z_]\w*$/.test(text)) return undefined;

  return text;
};

export { PRIMITIVE_TYPES, WRAPPER_GENERICS };
