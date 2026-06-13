# Design: Correctness Properties

Part of the [External Dependency Indexing Design](./design.md).

## Testability Analysis

| Property | Kind | Validates |
|---|---|---|
| EDI-P1 External detection totality | property | EDI-1 AC1 |
| EDI-P2 Relative paths never external | property | EDI-1 AC2 |
| EDI-P3 Node built-ins never external | property | EDI-1 AC3 |
| EDI-P4 PHP backslash paths are external | property | EDI-1 AC5 |
| EDI-P5 C system headers never external | property | EDI-1 AC6 |
| EDI-P6 Rust self/super/crate never external | property | EDI-1 AC8 |
| EDI-P7 Normalized name has no trailing separators | property | EDI-4 |
| EDI-P8 Aliases always include canonical name | property | EDI-5 AC1 |
| EDI-P9 ID is stable and deterministic | property | EDI-2 AC1 |
| EDI-P10 Alias matching is reflexive | property | EDI-5 AC2 |
| EDI-P11 Ecosystem is always a valid value | property | EDI-8 |
| EDI-P12 No dependsOn for internal imports | property | EDI-3 AC3 |
| EDI-P13 dependsOn target always starts with "ext:" | property | EDI-2 AC1 |
| EDI-P14 impact_analysis on external pkg returns dependents | example | EDI-6 AC1 |
| EDI-P15 impact_analysis on internal symbol unaffected | example | EDI-6 AC3 |

---

## Correctness Properties

### Property EDI-P1: External Package Detection Totality
For any path that is not relative, not `node:`, not a C system header, not a Rust internal path, `isExternalPackage` returns `true`.

```typescript
fc.assert(fc.property(
  fc.string({ minLength: 1 }).filter(s =>
    !s.startsWith("./") && !s.startsWith("../") && !s.startsWith("node:")
  ),
  (p) => isExternalPackage(p, "typescript") === true
));
```

### Property EDI-P2: Relative Paths Are Never External
```typescript
fc.assert(fc.property(
  fc.oneof(fc.string().map(s => "./" + s), fc.string().map(s => "../" + s)),
  (p) => isExternalPackage(p, "typescript") === false
));
```

### Property EDI-P3: Node Built-ins Are Never External
```typescript
fc.assert(fc.property(
  fc.string({ minLength: 1 }).map(s => "node:" + s),
  (p) => isExternalPackage(p, "typescript") === false
));
```

### Property EDI-P4: PHP Backslash Paths Are External
```typescript
fc.assert(fc.property(
  fc.string({ minLength: 1 }).map(s => "Vendor\\" + s),
  (p) => isExternalPackage(p, "php") === true
));
```

### Property EDI-P5: C System Headers Are Never External
```typescript
fc.assert(fc.property(
  fc.constantFrom(...C_SYSTEM_HEADERS),
  (h) => isExternalPackage(h, "c") === false
));
```

### Property EDI-P6: Rust Internal Paths Are Never External
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

### Property EDI-P7: Normalized Name Has No Trailing Separators
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

### Property EDI-P8: Aliases Always Include Canonical Name
```typescript
fc.assert(fc.property(
  fc.string({ minLength: 1 }),
  (name) => buildAliases(name)[0] === name && buildAliases(name).includes(name)
));
```

### Property EDI-P9: ExternalDependency ID Is Stable and Deterministic
```typescript
fc.assert(fc.property(
  fc.string({ minLength: 1 }).filter(s => !s.startsWith(".")),
  fc.constantFrom<Language>("typescript", "php", "java", "rust"),
  (name, lang) => {
    const map1 = new Map(); const map2 = new Map();
    const n1 = getOrCreateExtNode(name, lang, map1);
    const n2 = getOrCreateExtNode(name, lang, map2);
    return n1.id === n2.id && n1.id === `ext:${normalizePackageName(name, lang)}`;
  }
));
```

### Property EDI-P10: Alias Matching Is Reflexive
```typescript
fc.assert(fc.property(
  fc.string({ minLength: 1 }).filter(s => !s.startsWith(".")),
  (name) => {
    const node = getOrCreateExtNode(name, "typescript", new Map());
    return node.aliases.every(alias =>
      node.name.toLowerCase().includes(alias.toLowerCase()) ||
      node.aliases.some(a => a.toLowerCase() === alias.toLowerCase())
    );
  }
));
```

### Property EDI-P11: Ecosystem Is Always a Valid Value
```typescript
const VALID: PackageEcosystem[] = ["npm","composer","pip","maven","cargo","go_modules","unknown"];
fc.assert(fc.property(
  fc.constantFrom<Language>("typescript","php","python","java","rust","go","c","swift","ruby"),
  (lang) => VALID.includes(detectEcosystem(lang))
));
```

### Property EDI-P12: No dependsOn for Internal Imports
```typescript
fc.assert(fc.property(
  fc.array(relativeImportHintArbitrary(), { minLength: 1 }),
  (hints) => resolveHints(hints, []).relationships.every(r => r.relType !== "dependsOn")
));
```

### Property EDI-P13: dependsOn Target Always Starts With "ext:"
```typescript
fc.assert(fc.property(
  fc.array(externalImportHintArbitrary(), { minLength: 1 }),
  (hints) => resolveHints(hints, []).relationships
    .filter(r => r.relType === "dependsOn")
    .every(r => r.target.startsWith("ext:"))
));
```
