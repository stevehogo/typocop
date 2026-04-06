# Design: Correctness Properties

Part of the [External Dependency Indexing Design](./design.md).

## Testability Analysis

| Property | Kind | Validates |
|---|---|---|
| EDI-1 External detection totality | property | EDI-1 AC1 |
| EDI-2 Relative paths never external | property | EDI-1 AC2 |
| EDI-3 Node built-ins never external | property | EDI-1 AC3 |
| EDI-4 PHP backslash paths are external | property | EDI-1 AC5 |
| EDI-5 C system headers never external | property | EDI-1 AC6 |
| EDI-6 Rust self/super/crate never external | property | EDI-1 AC (Rust) |
| EDI-7 Normalized name has no excess separators | property | EDI-4 |
| EDI-8 Aliases always include canonical name | property | EDI-5 AC1 |
| EDI-9 ID is stable and deterministic | property | EDI-2 AC1 |
| EDI-10 Alias matching is reflexive | property | EDI-5 AC2 |
| EDI-11 Ecosystem is always a valid value | property | EDI-8 |
| EDI-12 No DEPENDS_ON for internal imports | property | EDI-3 AC3 |
| EDI-13 DEPENDS_ON target always starts with "ext:" | property | EDI-2 AC1 |
| EDI-14 impact_analysis on external pkg returns dependents | example | EDI-6 AC1 |
| EDI-15 impact_analysis on internal symbol unaffected | example | EDI-6 AC3 |

---

## Correctness Properties

### Property EDI-1: External Package Detection Totality
*For any* path that is not relative, not `node:`, not a C system header, not a Rust internal path, `isExternalPackage` returns `true`.

```typescript
fc.assert(fc.property(
  fc.string({ minLength: 1 }).filter(s =>
    !s.startsWith("./") && !s.startsWith("../") && !s.startsWith("node:")
  ),
  (p) => isExternalPackage(p, "typescript") === true
));
```

### Property EDI-2: Relative Paths Are Never External
```typescript
fc.assert(fc.property(
  fc.oneof(fc.string().map(s => "./" + s), fc.string().map(s => "../" + s)),
  (p) => isExternalPackage(p, "typescript") === false
));
```

### Property EDI-3: Node Built-ins Are Never External
```typescript
fc.assert(fc.property(
  fc.string({ minLength: 1 }).map(s => "node:" + s),
  (p) => isExternalPackage(p, "typescript") === false
));
```

### Property EDI-4: PHP Backslash Paths Are External
```typescript
fc.assert(fc.property(
  fc.string({ minLength: 1 }).map(s => "Vendor\\" + s),
  (p) => isExternalPackage(p, "php") === true
));
```

### Property EDI-5: C System Headers Are Never External
```typescript
const C_SYSTEM_HEADERS = ["stdio.h", "stdlib.h", "string.h", "vector", "iostream"];
fc.assert(fc.property(
  fc.constantFrom(...C_SYSTEM_HEADERS),
  (h) => isExternalPackage(h, "c") === false
));
```

### Property EDI-6: Rust Internal Paths Are Never External
```typescript
fc.assert(fc.property(
  fc.oneof(
    fc.string().map(s => "crate::" + s),
    fc.string().map(s => "super::" + s),
    fc.string().map(s => "self::" + s),
  ),
  (p) => isExternalPackage(p, "rust") === false
));
```

### Property EDI-7: Normalized Name Has No Excess Separators
*For any* language and import path, `normalizePackageName` returns a string with no trailing separators and at most the expected number of segments.

```typescript
fc.assert(fc.property(
  fc.constantFrom<Language>("typescript","php","java","rust","go","python"),
  fc.string({ minLength: 1 }).filter(s => !s.startsWith(".")),
  (lang, path) => {
    const n = normalizePackageName(path, lang);
    return n.length > 0 && !n.endsWith("/") && !n.endsWith("\\") && !n.endsWith(".");
  }
));
```

### Property EDI-8: Aliases Always Include Canonical Name
```typescript
fc.assert(fc.property(
  fc.string({ minLength: 1 }),
  (name) => {
    const aliases = buildAliases(name);
    return aliases[0] === name && aliases.includes(name);
  }
));
```

### Property EDI-9: ExternalDependency ID Is Stable and Deterministic
```typescript
fc.assert(fc.property(
  fc.string({ minLength: 1 }).filter(s => !s.startsWith(".")),
  fc.constantFrom<Language>("typescript", "php", "java", "rust"),
  (name, lang) => {
    const map = new Map<string, ExternalDependencyNode>();
    const n1 = getOrCreateExtNode(name, lang, map);
    const n2 = getOrCreateExtNode(name, lang, map);
    return n1.id === n2.id && n1.id === `ext:${normalizePackageName(name, lang)}`;
  }
));
```

### Property EDI-10: Alias Matching Is Reflexive
```typescript
fc.assert(fc.property(
  fc.string({ minLength: 1 }).filter(s => !s.startsWith(".")),
  (name) => {
    const node = getOrCreateExtNode(name, "typescript", new Map());
    return node.aliases.every(alias => matchesExternalDependency(node, alias));
  }
));
```

### Property EDI-11: Ecosystem Is Always a Valid Value
```typescript
const VALID: PackageEcosystem[] = ["npm","composer","pip","maven","cargo","go_modules","unknown"];
fc.assert(fc.property(
  fc.constantFrom<Language>("typescript","php","python","java","rust","go","c","swift"),
  (lang) => VALID.includes(detectEcosystem(lang))
));
```

### Property EDI-12: No DEPENDS_ON for Internal Imports
```typescript
fc.assert(fc.property(
  fc.array(relativeImportHintArbitrary(), { minLength: 1 }),
  (hints) => resolveHints(hints, []).every(r => r.relType !== "dependsOn")
));
```

### Property EDI-13: DEPENDS_ON Target Always Starts With "ext:"
```typescript
fc.assert(fc.property(
  fc.array(externalImportHintArbitrary(), { minLength: 1 }),
  (hints) => resolveHints(hints, [])
    .filter(r => r.relType === "dependsOn")
    .every(r => r.target.startsWith("ext:"))
));
```
