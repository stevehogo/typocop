---
inclusion: fileMatch
fileMatchPattern: ".kiro/specs/**"
---

# Spec File Size Limits

## Rule: No spec file should exceed 500 lines

When creating or updating spec files (`requirements.md`, `design.md`, `tasks.md`, or any design sub-document), each file must stay under 500 lines.

## When a file would exceed 500 lines

Split it into focused sub-files using a naming convention:

```
design.md               ← entry point, overview, diagrams
design-components.md    ← component interfaces
design-data-models.md   ← data models and algorithms
design-correctness.md   ← correctness properties and use cases
```

The main file must link to all sub-files at the top:

```markdown
**Related documents:**
- [Components & Interfaces](./design-components.md)
- [Data Models & Algorithms](./design-data-models.md)
- [Use Cases & Correctness Properties](./design-correctness.md)
```

Each sub-file must link back to the main file:

```markdown
Part of the [Code Graph Analyzer Design](./design.md).
```

## Applies to

- `design.md` and any design sub-documents
- `requirements.md` — split by domain or phase if needed
- `tasks.md` — split by milestone or phase if needed

## Enforcement

Before writing or appending to any spec file, estimate the resulting line count. If it would exceed 500 lines, split first, then write.
