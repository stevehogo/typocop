#!/usr/bin/env bash
set -e

# step 1: build
pnpm run build

# step 2: unlink existing global symlink (ignore error if not linked)
pnpm unlink --global || true

# step 3: link globally so `typocop` is available on PATH
pnpm link --global

# run typocop for path src/
# typocop parse ./src/ --language typescript
