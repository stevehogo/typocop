/**
 * TypeScript / JavaScript taint spec (Plan D, source task #5).
 *
 * Import-aware syntactic matchers for SOURCES (untrusted input), SINKS (by
 * `SinkKind`), and SANITIZERS. TS and JS share grammar shapes (call_expression,
 * member_expression, template_string, binary_expression), so one spec serves
 * both. PURE — reads the node + provenance, never mutates, never throws.
 *
 * Import-gated: a bare-name sink (`exec`, `query`) classifies ONLY when the name
 * is imported from the dangerous module — so a local `function exec(){}` is not a
 * command sink. Receiver-rooted patterns (`req.query`, `res.send`) need no import.
 *
 * Soundness: context-insensitive name matching ⇒ expect false positives (the
 * `explain` tool exists for human verification; never auto-act). Reference
 * implementation: an open-source CFG/taint indexer (no product names).
 */
import type Parser from "tree-sitter";
import type { ImportProvenance, SinkKind, TaintNodeCtx, TaintSpec } from "../types.js";

// ── Module/name catalogs ──────────────────────────────────────────────────────
const COMMAND_MODULES = new Set(["child_process", "node:child_process"]);
const COMMAND_NAMES = new Set(["exec", "execSync", "spawn", "spawnSync", "execFile"]);
const FS_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
const FS_READ_NAMES = new Set(["readFile", "readFileSync", "createReadStream", "readdir", "readdirSync"]);
const SOURCE_REQ_PROPS = new Set(["query", "body", "params"]);
const CODE_GLOBALS = new Set(["eval"]);
const ESCAPER_NAMES = new Set([
  "escape", "escapeHtml", "encodeURIComponent", "encodeURI", "escapeHTML",
]);
const NUMERIC_COERCERS = new Set(["Number", "parseInt", "parseFloat"]);
const VALIDATOR_GUARDS = new Set(["isInt", "isUUID", "isNumeric", "isAlphanumeric", "escape"]);
const SQL_QUERY_MEMBERS = new Set(["query", "raw", "execute"]);

// ── AST helpers (pure; tolerant of missing fields) ──────────────────────────
/** The `function` part of a call_expression, or undefined. */
function callee(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  if (node.type !== "call_expression") return undefined;
  return node.childForFieldName("function") ?? undefined;
}
/** The arguments node of a call_expression. */
function args(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  return node.childForFieldName("arguments") ?? undefined;
}
/** Named argument nodes of a call (excludes punctuation). */
function argList(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const a = args(node);
  if (!a) return [];
  const out: Parser.SyntaxNode[] = [];
  for (let i = 0; i < a.namedChildCount; i++) {
    const c = a.namedChild(i);
    if (c) out.push(c);
  }
  return out;
}
/** For a `a.b` member_expression: `{ objectText, property }`. */
function member(node: Parser.SyntaxNode): { object: Parser.SyntaxNode; objectText: string; property: string } | undefined {
  if (node.type !== "member_expression") return undefined;
  const object = node.childForFieldName("object");
  const property = node.childForFieldName("property");
  if (!object || !property) return undefined;
  return { object, objectText: object.text, property: property.text };
}
/** The leftmost identifier of a (possibly nested) member chain `a.b.c` → `a`. */
function rootIdentifier(node: Parser.SyntaxNode): string | undefined {
  let cur: Parser.SyntaxNode | null = node;
  while (cur) {
    if (cur.type === "identifier") return cur.text;
    if (cur.type === "member_expression") { cur = cur.childForFieldName("object"); continue; }
    if (cur.type === "call_expression") { cur = cur.childForFieldName("function"); continue; }
    if (cur.type === "subscript_expression") { cur = cur.childForFieldName("object"); continue; }
    return undefined;
  }
  return undefined;
}
/** True if the node is a plain string literal (no interpolation/concat). */
function isStringLiteralArg(n: Parser.SyntaxNode): boolean {
  return n.type === "string";
}
/** True if a node is "dynamic": a template_string with substitutions or a `+` concat. */
function isDynamicStringArg(n: Parser.SyntaxNode): boolean {
  if (n.type === "template_string") {
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c && c.type === "template_substitution") return true;
    }
    return false;
  }
  if (n.type === "binary_expression") {
    const op = n.childForFieldName("operator");
    return !!op && op.type === "+"; // string concat
  }
  return n.type === "identifier" || n.type === "member_expression" || n.type === "subscript_expression";
}

// ── Provenance ──────────────────────────────────────────────────────────────
/** Resolve the module a local name was imported from, via provenance. */
function moduleOf(name: string, imports: ImportProvenance): string | undefined {
  return imports.bySymbol.get(name) ?? imports.namespaces.get(name);
}

// ── SOURCE ────────────────────────────────────────────────────────────────────
/** `req.query` / `req.body` / `req.params` (or deeper) and `process.argv`. */
function isSource(ctx: TaintNodeCtx): boolean {
  const { node } = ctx;
  // member chain: req.query[.id] / process.argv
  let cur: Parser.SyntaxNode | null = node;
  while (cur && cur.type === "member_expression") {
    const m = member(cur)!;
    const root = rootIdentifier(cur);
    if (root === "req" && SOURCE_REQ_PROPS.has(m.property)) return true;
    if (root === "request" && SOURCE_REQ_PROPS.has(m.property)) return true;
    if (root === "process" && m.property === "argv") return true;
    cur = m.object;
  }
  // process.argv[n] subscript
  if (node.type === "subscript_expression") {
    const obj = node.childForFieldName("object");
    if (obj && obj.type === "member_expression") {
      const m = member(obj)!;
      if (rootIdentifier(obj) === "process" && m.property === "argv") return true;
    }
  }
  return false;
}

// ── SINK ────────────────────────────────────────────────────────────────────
function sinkKind(ctx: TaintNodeCtx): SinkKind | null {
  const { node, imports } = ctx;
  if (node.type !== "call_expression") {
    // `new Function(...)` is a new_expression
    if (node.type === "new_expression") {
      const ctor = node.childForFieldName("constructor");
      if (ctor && ctor.text === "Function") return "code";
    }
    return null;
  }
  const fn = callee(node);
  if (!fn) return null;

  // eval(...) — global code execution
  if (fn.type === "identifier" && CODE_GLOBALS.has(fn.text)) return "code";

  // bare-name command sink, import-gated: exec(...) where exec ∈ child_process
  if (fn.type === "identifier" && COMMAND_NAMES.has(fn.text)) {
    const mod = moduleOf(fn.text, imports);
    if (mod && COMMAND_MODULES.has(mod)) return "command";
  }

  // member call: cp.exec(...), fs.readFile(...), db.query(...), res.send(...)
  const m = member(fn);
  if (m) {
    const root = rootIdentifier(fn);
    // namespace command: cp.exec(...) where cp = child_process
    if (COMMAND_NAMES.has(m.property) && root && COMMAND_MODULES.has(moduleOf(root, imports) ?? "")) {
      return "command";
    }
    // fs path sink: fs.readFile(...) where fs = 'fs' (namespace) OR named readFile from fs
    if (FS_READ_NAMES.has(m.property) && root && FS_MODULES.has(moduleOf(root, imports) ?? "")) {
      return "path";
    }
    // xss: res.send / res.write / res.end with a non-constant arg
    if (root === "res" && (m.property === "send" || m.property === "write" || m.property === "end")) {
      const as = argList(node);
      if (as.some((a) => !isStringLiteralArg(a))) return "xss";
    }
    // sql: db.query(...) / conn.query(...) / .raw(...) with a DYNAMIC (non-literal) arg
    if (SQL_QUERY_MEMBERS.has(m.property)) {
      const as = argList(node);
      // Parameterized form (text + params array) is handled by isSanitizer; here
      // we flag the single-dynamic-arg form as a sink.
      const firstDynamic = as.length >= 1 && isDynamicStringArg(as[0]!);
      const parameterized = as.length >= 2 && (as[1]!.type === "array" || as[1]!.type === "identifier");
      if (firstDynamic && !parameterized) return "sql";
    }
  }

  // bare named fs read imported from fs: readFile(path)
  if (fn.type === "identifier" && FS_READ_NAMES.has(fn.text)) {
    const mod = moduleOf(fn.text, imports);
    if (mod && FS_MODULES.has(mod)) return "path";
  }
  return null;
}

// ── SANITIZER ─────────────────────────────────────────────────────────────────
function isSanitizer(ctx: TaintNodeCtx): boolean {
  const { node } = ctx;
  if (node.type !== "call_expression") return false;
  const fn = callee(node);
  if (!fn) return false;

  // bare escaper / numeric coercer: escape(x), encodeURIComponent(x), Number(x)
  if (fn.type === "identifier") {
    if (ESCAPER_NAMES.has(fn.text)) return true;
    if (NUMERIC_COERCERS.has(fn.text)) return true;
  }
  // member escaper / validator guard: he.encode(x), validator.escape(x), validator.isInt(x)
  const m = member(fn);
  if (m) {
    if (ESCAPER_NAMES.has(m.property)) return true;
    if (VALIDATOR_GUARDS.has(m.property)) return true;
    // parameterized query: db.query(text, params) — the parameterization sanitizes
    if (SQL_QUERY_MEMBERS.has(m.property)) {
      const as = argList(node);
      if (as.length >= 2 && (as[1]!.type === "array" || as[1]!.type === "identifier")) return true;
    }
  }
  return false;
}

export const typescriptTaintSpec: TaintSpec = { isSource, sinkKind, isSanitizer };

// ── Import provenance builder (consumed by the solver) ───────────────────────
/**
 * Build per-file {@link ImportProvenance} from a file's import hints (assembled
 * by Plan E's `provenanceOf()` from the AST — NOT from RawRelationshipHints,
 * which lack a `localName` for namespace/default imports). `targetName` is the
 * module specifier; `namedBindings` are the `{ local, exported }` pairs (named
 * imports); `localName` is the default/namespace local name (e.g. `* as cp`),
 * which maps that name to the module as a namespace.
 */
export interface ImportHintLike {
  readonly targetName: string; // module specifier
  readonly namedBindings?: readonly { local: string; exported: string }[];
  readonly localName?: string; // default/namespace local name, if any
}
export function buildImportProvenance(hints: readonly ImportHintLike[]): ImportProvenance {
  const bySymbol = new Map<string, string>();
  const namespaces = new Map<string, string>();
  for (const h of hints) {
    const mod = h.targetName;
    for (const b of h.namedBindings ?? []) {
      bySymbol.set(b.local, mod);
    }
    if (h.localName) namespaces.set(h.localName, mod);
  }
  return { bySymbol, namespaces };
}
