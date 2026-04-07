#!/usr/bin/env bash
# track-touched-file.sh
# Called by the spec-task-files-tracker postToolUse hook.
# Reads tool input JSON from stdin, extracts the written file path,
# and appends it to the active spec's files-touched.md if it's a src/ file.

set -euo pipefail

ACTIVE_SPEC_FILE=".kiro/specs/.active-spec"

# Step 1: check .active-spec exists and is non-empty
if [[ ! -f "$ACTIVE_SPEC_FILE" ]] || [[ ! -s "$ACTIVE_SPEC_FILE" ]]; then
  exit 0
fi

SPEC_PATH=$(cat "$ACTIVE_SPEC_FILE" | tr -d '[:space:]')

if [[ -z "$SPEC_PATH" ]]; then
  exit 0
fi

# Step 2: parse the written file path from stdin (tool input JSON)
# The hook passes tool input as JSON on stdin.
# fsWrite/strReplace tools have a "path" field; smartRelocate has "destinationPath".
# Use a short timeout so we don't block if stdin has no data.
STDIN_DATA=$(timeout 2 cat 2>/dev/null || true)

FILE_PATH=$(echo "$STDIN_DATA" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    # try common field names for write tools
    path = data.get('path') or data.get('destinationPath') or ''
    print(path)
except Exception:
    print('')
" 2>/dev/null || true)

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# Step 3: only track src/ files
if [[ "$FILE_PATH" != src/* ]]; then
  exit 0
fi

# Step 4: append to files-touched.md if not already listed
MANIFEST="$SPEC_PATH/files-touched.md"

if [[ -f "$MANIFEST" ]] && grep -qxF "$FILE_PATH" "$MANIFEST"; then
  exit 0
fi

echo "$FILE_PATH" >> "$MANIFEST"
