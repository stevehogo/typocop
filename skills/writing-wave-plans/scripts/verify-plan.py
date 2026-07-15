#!/usr/bin/env python3
"""Verify a multi-wave plan folder (writing-wave-plans skill, Step 4).

Usage:
  python3 verify-plan.py <plan-folder> --ids "F1-F8,U1-U11,E1-E2,Q1-Q7" [--root <repo-root>]

Checks (FAIL -> exit 1):
  - README.md + at least one wave-*.md exist
  - every backlog ID has exactly one `### Task <ID> —` heading (none missing, none duplicated)
  - every internal .md link resolves within the folder
  - every wave file has a `## Status tracking` section and a `Status:` line
  - every wave file has a gate task (`Task W<N>-GATE` / `Task <X>-GATE` / `Task FINAL`)
  - README has a wave-rollup status section
  - if ARCHITECTURE.md exists, README references it (links/paths in ALL *.md are scanned)
  - every design*.md is linked from some non-design plan file (README/wave/ARCHITECTURE),
    directly or transitively via its design spine — a self-referential design cluster FAILs
Warnings (reported, exit 0 unless --strict):
  - referenced repo *files* (a backticked path with an extension) that don't exist.
    Skipped: globs, `Create:` lines, branch/domain names, and extension-less tokens that
    don't resolve on disk (import paths like `database/sql`, to-be-created dirs) — so the
    check stays quiet on backend/CLI/library plans, not just frontend ones.
  - package scripts the plan invokes in code spans/fences (`yarn x` / `npm run x` / `pnpm x`)
    that the repo-root package.json does not define — a gate must not demand tooling the repo
    lacks (write its degraded form instead). Skipped when no root package.json exists;
    package-manager builtins (install, add, dlx, ...) are ignored.

IDs: comma-separated tokens; `F1-F8` expands to F1..F8; bare tokens pass through.
--root defaults to the nearest ancestor of the plan folder containing `.git`.
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path


def expand_ids(spec: str) -> list[str]:
    ids: list[str] = []
    for token in filter(None, (t.strip() for t in spec.split(","))):
        m = re.fullmatch(r"([A-Za-z]+)(\d+)-(?:[A-Za-z]+)?(\d+)", token)
        if m:
            prefix, lo, hi = m.group(1), int(m.group(2)), int(m.group(3))
            if hi < lo:
                sys.exit(f"FAIL: --ids range '{token}' is reversed/empty (expands to no IDs)")
            ids.extend(f"{prefix}{i}" for i in range(lo, hi + 1))
        else:
            ids.append(token)
    return ids


def find_root(start: Path) -> Path:
    cur = start.resolve()
    for parent in [cur, *cur.parents]:
        if (parent / ".git").exists():
            return parent
    return cur


def brace_expand(path: str) -> list[str]:
    m = re.search(r"\{([^}]*)\}", path)
    if not m:
        return [path]
    pre, post = path[: m.start()], path[m.end():]
    out: list[str] = []
    for part in m.group(1).split(","):
        out.extend(brace_expand(pre + part + post))
    return out


PATH_RE = re.compile(r"`([A-Za-z0-9_.-]+/[A-Za-z0-9_./{},*-]+)`")
LINK_RE = re.compile(r"\]\(([^)#\s]+\.md)(?:#[^)]*)?\)")
TASK_RE = re.compile(r"^### Task ([A-Za-z0-9-]+) —", re.M)
GATE_RE = re.compile(r"^### Task (?:[A-Za-z0-9]+-GATE|FINAL)\b", re.M)

# Package-script check: only text inside inline code spans / fenced blocks is scanned
# (prose like "we use yarn for installs" must not trip it).
CODE_SPAN_RE = re.compile(r"`([^`\n]+)`")
FENCE_RE = re.compile(r"```[^\n]*\n(.*?)```", re.S)
SCRIPT_CMD_RE = re.compile(r"\b(yarn|pnpm|npm)(\s+run)?\s+([A-Za-z][A-Za-z0-9:._-]*)")
PM_BUILTINS = {
    "yarn": {
        "install", "add", "remove", "upgrade", "upgrade-interactive", "up", "dlx", "exec",
        "init", "link", "unlink", "node", "why", "workspace", "workspaces", "cache", "config",
        "dedupe", "info", "pack", "patch", "patch-commit", "plugin", "rebuild", "set",
        "version", "bin", "create", "audit", "global", "list", "licenses", "outdated",
        "publish", "tag", "team", "policies", "import", "check", "help", "login", "logout",
        "unplug", "stage", "autoclean", "constraints", "explain", "search",
    },
    "pnpm": {
        "install", "i", "add", "remove", "rm", "update", "up", "dlx", "exec", "init", "link",
        "unlink", "why", "config", "audit", "list", "ls", "outdated", "publish", "patch",
        "patch-commit", "store", "create", "setup", "import", "rebuild", "prune", "fetch",
        "deploy", "root", "bin", "env", "help", "pack", "licenses", "server",
    },
}
NPM_BARE_SCRIPT_CMDS = {"test", "start", "stop", "restart"}  # only these run scripts without `run`


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", type=Path, help="plan folder (contains README.md + wave-*.md)")
    ap.add_argument("--ids", default="", help='backlog IDs, e.g. "F1-F8,U1-U11,E1-E2"')
    ap.add_argument("--root", type=Path, default=None, help="repo root for path checks")
    ap.add_argument("--strict", action="store_true", help="treat path warnings as failures")
    args = ap.parse_args()

    folder = args.folder.resolve()
    root = (args.root or find_root(folder)).resolve()
    failures: list[str] = []
    warnings: list[str] = []

    readme = folder / "README.md"
    waves = sorted(folder.glob("wave-*.md"))
    if not readme.exists():
        failures.append("README.md missing")
    if not waves:
        failures.append("no wave-*.md files found")
    if failures:
        print("\n".join(f"FAIL: {f}" for f in failures))
        return 1

    extra_docs = sorted(p for p in folder.glob("*.md") if p != readme and p not in waves)
    texts = {p: p.read_text(encoding="utf-8") for p in [readme, *waves, *extra_docs]}
    all_text = "".join(texts.values())

    print(f"root: {root}" + ("" if (root / ".git").exists() else "  (no .git found — path checks may be noisy; pass --root)"))

    # 1. Backlog-ID coverage (exactly one task heading per ID)
    ids = expand_ids(args.ids)
    if not ids:
        warnings.append("no --ids provided — backlog coverage NOT checked")
    headings = TASK_RE.findall(all_text)
    counts = {h: headings.count(h) for h in headings}
    missing = [i for i in ids if counts.get(i, 0) == 0]
    dupes = [i for i in ids if counts.get(i, 0) > 1]
    if missing:
        failures.append(f"backlog IDs with no 'Task <ID> —' heading: {missing}")
    if dupes:
        failures.append(f"backlog IDs with duplicate task headings: {dupes}")
    print(f"ids: {len(ids)} requested, {len(ids) - len(missing)} covered, dupes: {dupes or 'none'}")

    # 2. Internal links resolve
    broken = sorted(
        {t for text in texts.values() for t in LINK_RE.findall(text)
         if not t.startswith("http") and not (folder / t).exists()}
    )
    if broken:
        failures.append(f"broken internal links: {broken}")
    print(f"links: {'OK' if not broken else broken}")

    # 3. Per-wave status tracking + gates; README rollup
    for wave in waves:
        text = texts[wave]
        if "## Status tracking" not in text:
            failures.append(f"{wave.name}: no '## Status tracking' section")
        if not re.search(r"^Status:", text, re.M):
            failures.append(f"{wave.name}: no 'Status:' line")
        if not GATE_RE.search(text):
            failures.append(f"{wave.name}: no gate task (Task <X>-GATE or Task FINAL)")
    if "Status tracking" not in texts[readme]:
        failures.append("README.md: no wave-rollup 'Status tracking' section")
    arch = folder / "ARCHITECTURE.md"
    if arch.exists() and "ARCHITECTURE.md" not in texts[readme]:
        failures.append("ARCHITECTURE.md exists but README.md never links/references it (unwired)")
    designs = set(folder.glob("design*.md"))
    if designs:
        anchor_text = "".join(t for p, t in texts.items() if p not in designs)
        wired = {d for d in designs if d.name in anchor_text}
        grew = True
        while grew:  # a split (design-X-components.md) is wired via its wired spine
            grew = False
            for d in list(designs - wired):
                if any(d.name in texts[w] for w in wired):
                    wired.add(d)
                    grew = True
        for d in sorted(designs - wired):
            failures.append(
                f"{d.name}: no non-design plan file links it, directly or via its spine "
                "(orphan design doc — link it from the wave that builds the feature)"
            )
    print(f"waves: {len(waves)} files (+{len(extra_docs)} extra doc(s)), gates+status {'OK' if not any('gate' in f or 'Status' in f for f in failures) else 'ISSUES'}")

    # 4. Referenced repo paths exist (warnings)
    NON_PATH_FIRST_SEG = {"feature", "release", "hotfix", "bugfix", "origin", "refs"}
    for p, text in texts.items():
        for lineno, line in enumerate(text.splitlines(), 1):
            if "Create:" in line:
                continue
            for raw in PATH_RE.findall(line):
                first_seg = raw.split("/", 1)[0]
                if (
                    "*" in raw
                    or re.fullmatch(r"[\d/.x]+", raw)  # value notation like 8/14/16/20
                    or "." in first_seg  # domain names (s3-cdn.example.com/...)
                    or first_seg in NON_PATH_FIRST_SEG  # branch/ref names
                ):
                    continue
                for cand in brace_expand(raw):
                    clean = cand.rstrip("/")
                    if (root / clean).exists():
                        continue
                    # Only flag a missing token that looks like a FILE (has an extension in its
                    # last segment). Extension-less non-resolving tokens are language import paths
                    # (database/sql, net/http, encoding/json), to-be-created dirs, or prose — not
                    # file typos — so skip them to stay quiet on backend/CLI/library plans.
                    if "." not in clean.rsplit("/", 1)[-1]:
                        continue
                    warnings.append(f"{p.name}:{lineno} references missing path `{cand}`")
    print(f"paths: {len(warnings)} warning(s)" + (" (see below)" if warnings else ""))

    # 5. Package scripts the plan invokes actually exist (warnings)
    pkg = root / "package.json"
    if not pkg.exists():
        print("scripts: skipped (no package.json at root)")
    else:
        try:
            scripts = set((json.loads(pkg.read_text(encoding="utf-8")).get("scripts") or {}))
        except (json.JSONDecodeError, OSError) as e:
            scripts = None
            print(f"scripts: skipped (package.json unreadable: {e})")
        if scripts is not None:
            hits: dict[tuple[str, str], int] = {}
            for text in texts.values():
                code = "\n".join(CODE_SPAN_RE.findall(text)) + "\n" + "\n".join(FENCE_RE.findall(text))
                for tool, ran, word in SCRIPT_CMD_RE.findall(code):
                    if tool == "npm":
                        if not ran and word not in NPM_BARE_SCRIPT_CMDS:
                            continue  # bare npm subcommands other than test/start/... are builtins
                    elif not ran and word in PM_BUILTINS[tool]:
                        continue
                    if word not in scripts:
                        hits[(tool, word)] = hits.get((tool, word), 0) + 1
            for (tool, word), n in sorted(hits.items()):
                run_part = " run" if tool == "npm" else ""
                warnings.append(
                    f"plan invokes `{tool}{run_part} {word}` ({n}x) but package.json defines no script "
                    f"'{word}' — a gate must not demand tooling the repo lacks; write its degraded form"
                )
            print(f"scripts: {len(hits)} undefined-script warning(s)")

    for w in warnings:
        print(f"WARN: {w}")
    for f in failures:
        print(f"FAIL: {f}")
    ok = not failures and not (args.strict and warnings)
    print("VERDICT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
