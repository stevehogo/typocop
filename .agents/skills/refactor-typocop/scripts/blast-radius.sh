#!/usr/bin/env bash
# Scope a module move: how many non-test files import a given src/ module,
# and which files of the module are imported (deep-import breakdown).
# Usage: blast-radius.sh <module-dir-under-src>     e.g.  blast-radius.sh db
set -uo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "not in a git repo"; exit 1; }
cd "$root" || exit 1

m="${1:-}"
[ -z "$m" ] && { echo "usage: blast-radius.sh <module-dir-under-src>  (e.g. db, types, query)"; exit 2; }
[ -d "src/$m" ] || { echo "no such module: src/$m"; exit 2; }

excludes=(--exclude='*.test.ts' --exclude='*.pbt.test.ts' --exclude='*.property.test.ts'
          --exclude='*.integration.test.ts' --exclude='*.test-support.ts')

echo "== Non-test files importing src/$m/ =="
importers="$(grep -rlE "from \"(\.\./)+${m}/" src --include='*.ts' "${excludes[@]}" 2>/dev/null \
            | grep -v "^src/${m}/" | sort -u)"
if [ -n "$importers" ]; then echo "$importers" | sed 's/^/  /'; fi
echo "  count: $(printf '%s\n' "$importers" | grep -c . )"
echo

echo "== Deep-import breakdown (which files of src/$m/ are imported) =="
grep -rhoE "from \"(\.\./)+${m}/[A-Za-z0-9_-]+\.js\"" src --include='*.ts' \
  | sed -E "s#.*/(${m}/[A-Za-z0-9_-]+\.js)\"#\1#" | sort | uniq -c | sort -rn | head -25

echo
echo "== Test files under src/$m/ that would move with it =="
find "src/$m" -name '*.test.ts' -o -path "src/$m/*" -name '*.pbt.test.ts' 2>/dev/null | wc -l | sed 's/^/  /'
