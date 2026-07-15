# Exemplar: condensed excerpts from a real wave plan

Condensed **and anonymized** from a shipped 55-row branding-migration plan (7 waves) so you can
see the templates *filled in*. Illustrative only — structure is normative (`templates.md`); these
values are not (names, hexes, and hashes are fictionalized; the incidents are real).

---

## README.md excerpts

```markdown
# Branding Migration — Master Plan (multi-wave)

Status: not started
Created: 2026-07-10 · Branch: `feature/adopt-new-branding` · Covers **all 55 rows** of the Estimation sheet in `docs/branding-migration-estimate.xlsx`.

> **For Claude:** Execute task-by-task, one commit per task. Each wave is its own file in this
> folder and **owns its task-level status tracking** — update the wave file's *Status tracking*
> section as you work, then roll the wave-level result up to the table below. Use the repo skills
> named in each task. Keep these files in sync per `CLAUDE.md → ## Plans`.

**Goal:** Re-brand the storefront portal to the official brand guide — `docs/brand-guide.pdf` v1.0,
transcribed with SCSS mappings in `docs/brand-guide.md` — across foundation tokens, UI primitives,
cards, global components, sections, all pages, and cross-cutting QA.

**Architecture:** Token-first cascade. Wave 0 **creates** the brand token layer — this unblocks
everything else. Waves 1–5 restyle upward through the component tree, migrating consumers
**explicitly** onto the new tokens (two-step add → migrate → retire; no big-bang repoint of the
legacy vars). Wave 6 is the QA/release gate. Cream canvas rolls out per-page in Wave 5, marketing
first, booking/enquiry last.

## Reality baseline (read before Wave 0)

The working tree is **fully legacy — a previous implementation round was reverted**:
- **Fonts:** the legacy webfont ships as 9 weight-named families off the CDN. The brand font
  (Inter) is NOT loaded.
- **Colors:** primary CTAs are legacy blue (`$blue-secondary: #0A5CE8`); no `$brand-green` /
  `$gold-accent` / `$ring` flat tokens exist.
- ⚠️ **Stale docs:** the guide's §15 "App SCSS today" column describes the *reverted* tree (claims
  tokens "exist"). Task **F0** reconciles it before any code changes.
- **Toolchain:** Node 20, Yarn. **Vue pinned 3.4.38** — a floated 3.5 compiler crashes `yarn build`
  on valid templates; the pin is load-bearing for every gate.
- **Verification capability (execution environment):** build ✓ · e2e/browsers ✗ (no Playwright
  browsers) · dev server ✗ — gates run build + targeted greps + read-only auditor agents; visual
  and keyboard checks route to the wave testing summaries as human checks.

| Sheet cell | Sheet says (stale) | Actual spec (guide) |
|---|---|---|
| F2 note | "Body 500, headings 700" | Body **400**; labels/CTAs 500; headlines 700 (ruling D5) |
| F3 task | "12 / 10 / 8px" | Radius scale **4 / 6 / 8 / 12**, default **8px** (ruling D10) |

## Shared conventions (excerpt)

- **Spec first.** `docs/brand-guide.md`; on any conflict, the guide wins.
- **No invented identifiers.** Any class/token a task newly references is grep-proven to exist first
  — a swap to a `.button-secondary` that was never defined shipped unstyled CTAs; only the gate
  audit caught it.
- **Per-wave testing summary:** at each gate, write `docs/branding-migration-summary/wave-N-*.md` —
  what changed · how to verify · **intentionally NOT changed yet** (mid-rollout, a cream header on a
  still-white page body is *expected*; say so or testers file it as a regression).

## Dependency graph

WAVE 0 — Foundation (F0–F8)  ← everything depends on this
   ▼
WAVE 1 — UI primitives (U1–U11)          [U3←U2 · U9←U1]
   ├───────────────┬────────────────┐
   ▼               ▼                │
WAVE 2 — Cards   WAVE 3 — Chrome    │  Track B independent of Track A —
(E2←U9)          (G3←U3)            │  run in parallel after Wave 1
   ▼               │                │
WAVE 4 — Sections  │                │
   └───────┬───────┘                │
           ▼
    WAVE 5 — Pages → WAVE 6 — QA & release

## Status tracking (wave rollup)

Task-level state lives in each wave file — this table is the wave-level rollup.
Legend: `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked (note why).

| Wave | Status | Notes |
|---|---|---|
| 0 — Foundation tokens (F0–F8) | [ ] | |
| 1 — UI primitives (U1–U11) | [ ] | |
| Final verification | [ ] | |
```

---

## wave-N file excerpts

```markdown
# Wave 0 — Foundation SCSS tokens + global type (F0–F8)

> Part of the [Branding Migration master plan](README.md). Read the shared conventions first.
> Skill: **`migrate-brand-tokens`**. Guide sections: §15 (token block), §16 (rulings).
> **Next:** [Wave 1 — UI primitives](wave-1-ui-primitives.md)

**Depends on:** nothing — base wave. **Unblocks:** every other wave.
**Nothing visual changes until F2/F7** (F1/F3/F4 add unused tokens = zero-risk commits).

## Status tracking — Wave 0

Status: not started

- [ ] F0 — Reconcile stale docs with the reverted tree
- [ ] F1 — Core palette + semantic tokens
- [ ] W0-GATE — Wave verification gate

<!-- Ticked lines carry evidence (hash + delta + deviations/deferrals), e.g. how this looked done:
- [x] F1 — Core palette + semantic tokens — `a1b2c3d`. Tokens added, no consumers yet; deviation:
  scroll-elevation not wired (no scroll handler exists — shadow applied at rest, noted).
- [x] W0-GATE — build exit 0 (Vue 3.4.38); e2e NOT run in-session (no browsers — degraded to
  greps + auditor agents); audits 0 HIGH after remediation `e4f5a6b`; deferred to Q4: content-link
  focus rings, small tap targets. Summary: docs/branding-migration-summary/wave-0-*.md
-->

### Task F1 — Core palette + semantic tokens

**Covers:** F1 (M) · depends: —
**Files:**
- Modify: `assets/scss/src/_variables.scss` (insert after the legacy color block)

**Step 1: Add the token block** (from guide §15, adapted with `!default` to match file style):
    $brand-green:  #166B54 !default; // --primary
    $green-deep:   #0D4437 !default; // D3 hover/active (#0D5A46 is a PDF typo — D12)
**Step 2:** `yarn build` — exits 0. No visual change expected (tokens have no consumers yet).
**Step 3:** Commit: `feat(brand): F1 — core palette tokens from brand-guide §15`.

<!-- Compact form (small plans) — same invariants, one block: -->
### Task T1 — Color tokens to brand green
**Covers:** T1 (S) · depends — · **Modify:** `src/styles/tokens.css`
**Steps:** 1) Edit the `--primary` value. 2) Verify: `grep -c "#117755" src/styles/tokens.css` → `1`.
3) Commit: `style(tokens): T1 — primary to brand green`.

### Task W0-GATE — Wave verification gate

1. `yarn build` exits 0 (on the pinned Vue 3.4.38 — see Reality baseline).
2. e2e/visual: ✗ in this environment (no browsers) — degraded form: targeted greps + the audits
   below; record "e2e not verified in-session" in the status line.
3. Fresh-context audit: **`verify-style-migration`** workflow (`coverage` dimension) — or the
   standalone read-only `style-conformance-auditor` agent when workflows need an unavailable
   opt-in. Scope: `assets/scss/src/` **plus global consumers** (`_normalize.scss` — a W1 gate
   found a global `outline:none !important` silently killing every focus ring the wave added).
4. Triage: fix in-scope high/medium + cheap nits now; re-home each deferral onto a named Wave-6
   task (Q2/Q4/Q5) and record it in this file's gate status line.
5. Commit remediation (if any): `fix(brand): W0 gate — remediate audit findings`.
6. Testing summary: write `docs/branding-migration-summary/wave-0-foundation-tokens.md` — what
   changed · how to verify · intentionally NOT changed yet — + its index row.
7. Update: this file's Status → all `[x]` with hashes/deviations; README rollup row (outcome ·
   env caveats · deferrals).
8. Commit: `docs(brand): W0 gate — foundation wave complete`.
9. **Context checkpoint:** stop — announce Wave 0 is complete and committed; safe point to
   `/compact` or `/clear` before Wave 1 (a fresh context resumes via README → wave-1 file).

**Wave 0 done when:** F0–F8 committed, gate passed. → [Wave 1](wave-1-ui-primitives.md).
```
