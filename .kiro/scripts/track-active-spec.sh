#!/usr/bin/env bash
# track-active-spec.sh
# Called when a tasks.md or tasks-*.md file is edited.
# Finds the spec folder and writes it to .kiro/specs/.active-spec if any task is in-progress.

set -euo pipefail

EDITED_FILE="$1"

if [[ ! -f "$EDITED_FILE" ]]; then
  exit 0
fi

# Extract spec folder from the file path
# Expected: .kiro/specs/{spec-name}/tasks.md or .kiro/specs/{spec-name}/tasks-*.md
if [[ "$EDITED_FILE" =~ ^\.kiro/specs/([^/]+)/tasks(-[^/]+)?\.md$ ]]; then
  SPEC_NAME="${BASH_REMATCH[1]}"
  SPEC_PATH=".kiro/specs/$SPEC_NAME"
  SPEC_DIR="$SPEC_PATH"
else
  exit 0
fi

# Check if any task is in-progress (marked with [-]) across ALL task files
# Look in tasks.md and any tasks-*.md files in the same folder
if find "$SPEC_DIR" -maxdepth 1 -name "tasks*.md" -type f -exec grep -l "^\s*-\s*\[-\]" {} \; | grep -q .; then
  echo "$SPEC_PATH" > ".kiro/specs/.active-spec"
else
  # No in-progress tasks, clear the active spec
  rm -f ".kiro/specs/.active-spec"
fi
