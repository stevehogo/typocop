/**
 * Wave 6 — Eloquent model property/relationship extraction.
 *
 * Indexes Eloquent model array properties (`$fillable`/`$casts`/`$hidden`/
 * `$guarded`/`$with`/`$appends`) and relationship methods (`hasMany`/`belongsTo`/
 * `morph*`/etc.) into description strings that enrich the owning model Symbol.
 *
 * NOTE: `findDescendant` / `extractStringContent` here are DELIBERATELY distinct
 * from the same-named helpers in `laravel-routes.ts` — this module reads the
 * tree-sitter `string_content` token rather than slicing quotes. They are NOT
 * interchangeable; keep them separate.
 *
 * Provenance: ported from the legacy parser (typocop's pre-refactor parser
 * lineage). Nodes are tree-sitter raw nodes, hence `any`-typed.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Eloquent array-valued model properties worth indexing. */
const ELOQUENT_ARRAY_PROPS = new Set(["fillable", "casts", "hidden", "guarded", "with", "appends"]);

/** Eloquent relationship method names. */
const ELOQUENT_RELATIONS = new Set([
  "hasMany",
  "hasOne",
  "belongsTo",
  "belongsToMany",
  "morphTo",
  "morphMany",
  "morphOne",
  "morphToMany",
  "morphedByMany",
  "hasManyThrough",
  "hasOneThrough",
]);

function findDescendant(node: any, type: string): any {
  if (node.type === type) return node;
  for (const child of node.children ?? []) {
    const found = findDescendant(child, type);
    if (found) return found;
  }
  return null;
}

function extractStringContent(node: any): string | null {
  if (!node) return null;
  const content = node.children?.find((c: any) => c.type === "string_content");
  if (content) return content.text;
  if (node.type === "string_content") return node.text;
  return null;
}

/**
 * For a PHP `property_declaration` node, extract its array values as a
 * description string. Returns `null` if it is not an indexed Eloquent property
 * or has no array values. `$casts` pairs render as `key:value`; simple-value
 * arrays (`$fillable`/`$hidden`) render as comma-joined values.
 */
export function extractPhpPropertyDescription(propName: string, propDeclNode: any): string | null {
  if (!ELOQUENT_ARRAY_PROPS.has(propName)) return null;

  const arrayNode = findDescendant(propDeclNode, "array_creation_expression");
  if (!arrayNode) return null;

  const items: string[] = [];
  for (const child of arrayNode.children ?? []) {
    if (child.type !== "array_element_initializer") continue;
    const children = child.children ?? [];
    const arrowIdx = children.findIndex((c: any) => c.type === "=>");
    if (arrowIdx !== -1) {
      const key = extractStringContent(children[arrowIdx - 1]);
      const val = extractStringContent(children[arrowIdx + 1]);
      if (key && val) items.push(`${key}:${val}`);
    } else {
      const val = extractStringContent(children[0]);
      if (val) items.push(val);
    }
  }

  return items.length > 0 ? items.join(", ") : null;
}

/**
 * For a PHP method node, detect an Eloquent relationship call
 * (`$this->hasMany(Post::class)`). Returns e.g. `"hasMany(Post)"` or `null`.
 */
export function extractEloquentRelationDescription(methodNode: any): string | null {
  function findRelationCall(node: any): any {
    if (node.type === "member_call_expression") {
      const children = node.children ?? [];
      const objectNode = children.find((c: any) => c.type === "variable_name" && c.text === "$this");
      const nameNode = children.find((c: any) => c.type === "name");
      if (objectNode && nameNode && ELOQUENT_RELATIONS.has(nameNode.text)) return node;
    }
    for (const child of node.children ?? []) {
      const found = findRelationCall(child);
      if (found) return found;
    }
    return null;
  }

  const callNode = findRelationCall(methodNode);
  if (!callNode) return null;

  const relType = callNode.children?.find((c: any) => c.type === "name")?.text;
  const argsNode = callNode.children?.find((c: any) => c.type === "arguments");
  let targetModel: string | null = null;
  if (argsNode) {
    const firstArg = argsNode.children?.find((c: any) => c.type === "argument");
    if (firstArg) {
      const classConstant = firstArg.children?.find(
        (c: any) => c.type === "class_constant_access_expression",
      );
      if (classConstant) {
        targetModel = classConstant.children?.find((c: any) => c.type === "name")?.text ?? null;
      }
    }
  }

  if (relType && targetModel) return `${relType}(${targetModel})`;
  if (relType) return relType;
  return null;
}

/**
 * One extracted Eloquent model class: its name + the indexed array-property and
 * relationship descriptions. `fillable` etc. render as comma-joined values;
 * `relations` preserve the TARGET class name (`hasMany(Post)`), the useful signal
 * for Wave 5 model→model resolution.
 */
export interface ExtractedEloquentModel {
  /** The model class name (matched against `Symbol.name` to enrich it). */
  readonly className: string;
  /** Array-prop descriptions keyed by prop name (`fillable`/`casts`/…). */
  readonly properties: Record<string, string>;
  /** Relationship descriptions, e.g. `["hasMany(Post)", "belongsTo(User)"]`. */
  readonly relations: string[];
}

/** Does a PHP `class_declaration` extend Eloquent's `Model`/`Authenticatable`? */
function isEloquentModelClass(classNode: any): boolean {
  // tree-sitter-php exposes the base via a `base_clause` child carrying a `name`
  // / `qualified_name` token. Be liberal: scan the class header text for the
  // canonical bases (mirrors `laravel.ts::parseEloquentModels`' signature gate).
  for (const child of classNode.children ?? []) {
    if (child.type === "base_clause") {
      const text: string = child.text ?? "";
      if (/\b(Model|Authenticatable)\b/.test(text)) return true;
    }
  }
  return false;
}

/**
 * Walk a PHP tree and extract every Eloquent model class (gated on
 * `extends Model`/`extends Authenticatable`) with its indexed array properties
 * and relationship methods. Pure; never throws on a degenerate tree.
 *
 * Operates on the ALREADY-PARSED tree (no second `fs.readFile`, no new `Parser`).
 */
export function extractEloquentModels(tree: any): ExtractedEloquentModel[] {
  const models: ExtractedEloquentModel[] = [];

  const walk = (node: any): void => {
    if (node.type === "class_declaration" && isEloquentModelClass(node)) {
      const className = node.childForFieldName?.("name")?.text ?? null;
      if (className) {
        const properties: Record<string, string> = {};
        const relations: string[] = [];
        const body = node.childForFieldName?.("body");
        for (const member of body?.children ?? []) {
          if (member.type === "property_declaration") {
            // `property_declaration > property_element > variable_name > name`.
            const propName = member.children
              ?.find((c: any) => c.type === "property_element")
              ?.children?.find((c: any) => c.type === "variable_name")
              ?.children?.find((c: any) => c.type === "name")
              ?.text;
            if (propName) {
              const desc = extractPhpPropertyDescription(propName, member);
              if (desc) properties[propName] = desc;
            }
          } else if (member.type === "method_declaration") {
            const rel = extractEloquentRelationDescription(member);
            if (rel) relations.push(rel);
          }
        }
        models.push({ className, properties, relations });
      }
    }
    for (const child of node.children ?? []) walk(child);
  };

  walk(tree.rootNode);
  return models;
}
