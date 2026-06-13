#!/usr/bin/env bash
# Per-step green gate for the Typocop refactor.
# Runs every check that must pass before a migration step
# (docs/refactoring/TARGET-ARCHITECTURE.md §15) is considered done.
# typecheck:tests and depcruise are skipped until PR 0 adds them.
set -uo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "not in a git repo"; exit 1; }
cd "$root" || exit 1

fail=0
run() { # run <label> <cmd...>
  local label="$1"; shift
  echo "── ${label} ──"
  if "$@"; then echo "✓ ${label}"; else echo "✗ ${label}"; fail=1; fi
  echo
}
has_script() { pnpm run 2>/dev/null | grep -qE "^[[:space:]]*${1}([[:space:]]|$)"; }

run "typecheck (src)" pnpm typecheck
has_script "typecheck:tests" && run "typecheck (tests)" pnpm typecheck:tests \
  || echo "· skip typecheck:tests (not wired yet — PR 0)"; echo
run "tests" pnpm test
has_script "depcruise" && run "dependency-cruiser" pnpm depcruise src \
  || echo "· skip depcruise (not wired yet — PR 0)"; echo

if [ "$fail" -eq 0 ]; then
  echo "GREEN ✓ — step gate passed"
else
  echo "RED ✗ — gate failed; fix or revert this step, do not finish it red"
fi
exit "$fail"
