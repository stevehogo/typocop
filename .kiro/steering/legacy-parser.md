---
inclusion: fileMatch
fileMatchPattern: "src/parser/**"
---

# Legacy Parser — Read Only

The `legacy-parser/` folder contains a reference implementation of a code parser.

## Rule: Do not edit any files in `legacy-parser/`

This folder is a read-only reference. It exists for inspiration and comparison only.

- Do NOT modify, refactor, or delete any files under `legacy-parser/`
- Do NOT add new files to `legacy-parser/`
- You MAY read files in `legacy-parser/` to understand patterns or extract logic
- New implementation goes in `src/parser/` — never back into `legacy-parser/`
