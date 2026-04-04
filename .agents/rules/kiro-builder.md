---
trigger: always_on
---

# Kiro-Antigravity Project Constitution

## 🚩 FEATURE FLAG & SCOPE
- **Current Feature:** code-graph-analyzer
- **Active Spec Path:** @.kiro/specs/code-graph-analyzer/
- **Strict Mode:** ON (Do not edit files outside the Active Spec Path unless global config).

## 1. SOURCE OF TRUTH HIERARCHY
1. **Requirements:** Refer to `requirements.md` for User Stories/EARS notation.
2. **Design:** Refer to `design.md` for architecture and tech stack constraints.
3. **Tasks:** Refer to `tasks.md` for the sequence of execution.

## 2. CORE COMMANDMENTS
- **EARS Compliance:** All logic must satisfy the "WHEN/THE SYSTEM SHALL" conditions in requirements.
- **Architectural Integrity:** You are forbidden from introducing patterns not defined in `design.md`.
- **Sync Requirement:** No code change is complete until the corresponding task in `tasks.md` is checked [x].