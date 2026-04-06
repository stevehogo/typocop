# Design: Data Models & Algorithms

Part of the [External Dependency Indexing Design](./design.md).

## New Type: ExternalDependencyNode

Added to `src/types/index.ts`:

```typescript
export interface ExternalDependencyNode {
  /** Stable ID: "ext:{normalizedPackageName}" e.g. "ext:neo4j-driver" */
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly ecosystem: PackageEcosystem;
}

export type PackageEcosystem =
  | "npm" | "composer" | "pip" | "maven"
  | "cargo" | "go_modules" | "unknown";
```

## New RelationType: "dependsOn"

```typescript
export type RelationType =
  | "calls" | "imports" | "inherits" | "implements"
  | "contains" | "references" | "defines"
  | "dependsOn";   // ← new: internal symbol → ExternalDependencyNode
```

## Neo4j Graph Schema

```
(:Symbol)-[:DEPENDS_ON]->(:ExternalDependency {
  id:        "ext:neo4j-driver",
  name:      "neo4j-driver",
  aliases:   ["neo4j", "Neo4j", "Neo4jDriver", "neo4j-driver"],
  ecosystem: "npm"
})
```

## Algorithm: isExternalPackage

Accepts the raw `targetName` from a `RawRelationshipHint` and the source file language.

```
FUNCTION isExternalPackage(importPath: string, language: Language): boolean
  // Relative paths — all languages
  IF importPath STARTS WITH "./" OR "../" THEN RETURN false

  // Node.js built-ins
  IF importPath STARTS WITH "node:" THEN RETURN false

  // C/C++ system headers: angle-bracket form or known POSIX names
  IF language IS "c" OR "cpp" THEN
    IF importPath STARTS WITH "<" THEN RETURN false
    IF importPath IN C_SYSTEM_HEADERS THEN RETURN false
  END IF

  // PHP: backslash-separated namespace — external if root vendor is not
  // a tsconfig alias (alias resolution already strips those)
  IF language IS "php" THEN RETURN true

  // Java/C#: dot-separated — always external (internal refs use call hints)
  IF language IS "java" OR "csharp" THEN RETURN true

  // Rust: crate::path — external if not "crate::", "super::", "self::"
  IF language IS "rust" THEN
    IF importPath STARTS WITH "crate::" OR "super::" OR "self::" THEN RETURN false
    RETURN true
  END IF

  // Go: module path — external if not resolved by goModule config
  // (resolveAlias already handles internal module paths)
  IF language IS "go" THEN RETURN true

  // Swift: bare framework name — always external
  IF language IS "swift" THEN RETURN true

  // Ruby: handled via require call hints (see EDI-9)
  // TS/JS: scoped (@neo4j/...) or bare specifier
  RETURN true
END FUNCTION
```

`C_SYSTEM_HEADERS` is a `ReadonlySet<string>` of POSIX/C++ standard headers
(`stdio.h`, `stdlib.h`, `string`, `vector`, `iostream`, etc.) defined as a
constant in `src/utils/limits.ts`.

## Algorithm: normalizePackageName

```
FUNCTION normalizePackageName(importPath: string, language: Language): string
  SWITCH language
    CASE "php":
      // "Illuminate\Http\Request" → "Illuminate"
      RETURN importPath.split("\\")[0]

    CASE "java", "csharp":
      // "com.neo4j.driver.Driver" → "com.neo4j"
      parts ← importPath.split(".")
      RETURN parts.slice(0, 2).join(".")   // top 2 segments

    CASE "rust":
      // "serde::Serialize" → "serde"
      RETURN importPath.split("::")[0]

    CASE "go":
      // "github.com/neo4j/neo4j-go-driver/v5" → "github.com/neo4j/neo4j-go-driver"
      parts ← importPath.split("/")
      IF parts[0] IN GO_VCS_HOSTS THEN   // github.com, gitlab.com, etc.
        RETURN parts.slice(0, 3).join("/")
      END IF
      RETURN parts[0]   // non-VCS: single segment

    CASE "c", "cpp":
      // "openssl/ssl.h" → "openssl"
      RETURN importPath.split("/")[0].replace(/\.h$/, "")

    DEFAULT:  // typescript, javascript, ruby, swift, python
      IF importPath STARTS WITH "@" THEN
        parts ← importPath.split("/")
        RETURN parts[0] + "/" + parts[1]   // "@scope/package"
      END IF
      RETURN importPath.split("/")[0]
  END SWITCH
END FUNCTION
```

`GO_VCS_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org", "golang.org", "gopkg.in"])`

## Algorithm: buildAliases

```
FUNCTION buildAliases(packageName: string): string[]
  aliases ← [packageName]
  base ← packageName
    .replace(/^@[^/]+\//, "")   // strip npm scope
    .replace(/::.+$/, "")       // strip Rust path
    .replace(/\\.+$/, "")       // strip PHP namespace tail
    .replace(/\..+$/, "")       // strip Java/C# package tail

  camel   ← toCamelCase(base)
  pascal  ← toPascalCase(base)
  stripped ← base.replace(/[-_.]/g, "")

  FOR each variant IN [base, camel, pascal, stripped] DO
    IF variant NOT IN aliases THEN aliases.push(variant)
  END FOR
  RETURN aliases
END FUNCTION
```

## Algorithm: detectEcosystem

```
FUNCTION detectEcosystem(language: Language): PackageEcosystem
  SWITCH language
    CASE "typescript", "javascript": RETURN "npm"
    CASE "php":                      RETURN "composer"
    CASE "python":                   RETURN "pip"
    CASE "java":                     RETURN "maven"
    CASE "rust":                     RETURN "cargo"
    CASE "go":                       RETURN "go_modules"
    DEFAULT:                         RETURN "unknown"
  END SWITCH
END FUNCTION
```

## Algorithm: resolveHints (modified import case)

```
CASE "import":
  IF isExternalPackage(hint.targetName, hint.language) THEN
    pkgName ← normalizePackageName(hint.targetName, hint.language)
    extId   ← "ext:" + pkgName
    IF NOT extNodes.has(extId) THEN
      extNodes.set(extId, {
        id:        extId,
        name:      pkgName,
        aliases:   buildAliases(pkgName),
        ecosystem: detectEcosystem(hint.language),
      })
    END IF
    add({ relType: "dependsOn", source: sourceId, target: extId, ... })
  ELSE
    // existing internal resolution logic (unchanged)
  END IF
```

`RawRelationshipHint` gains a `language: Language` field populated by the parser.

## Cypher: findExternalDependencyByAlias

```cypher
MATCH (ext:ExternalDependency)
WHERE ext.name =~ $pattern
   OR any(alias IN ext.aliases WHERE alias =~ $pattern)
RETURN ext LIMIT 1
```

`$pattern = "(?i).*<query>.*"`

## Cypher: impact analysis for external deps

```cypher
MATCH (n)-[:DEPENDS_ON*1..$maxDepth]->(ext:ExternalDependency {id: $extId})
RETURN DISTINCT n
```
