#!/usr/bin/env bash
# check-spec-completion.sh
# Called when a spec task completes.
# Checks if all required tasks are done, scans for TODOs, and either reports them or marks spec as done.

set -euo pipefail

ACTIVE_SPEC_FILE=".kiro/specs/.active-spec"

# Step 1: Get active spec path
if [[ ! -f "$ACTIVE_SPEC_FILE" ]] || [[ ! -s "$ACTIVE_SPEC_FILE" ]]; then
  exit 0
fi

SPEC_PATH=$(cat "$ACTIVE_SPEC_FILE" | tr -d '[:space:]')

if [[ -z "$SPEC_PATH" ]] || [[ ! -d "$SPEC_PATH" ]]; then
  exit 0
fi

SPEC_NAME=$(basename "$SPEC_PATH")

# Step 2: Check if all required tasks are marked [x]
# Scan all tasks*.md files in the spec folder
ALL_DONE=true
while IFS= read -r line; do
  # Match required task lines: - [x] or - [ ] (no asterisk after bracket)
  if [[ "$line" =~ ^[[:space:]]*-[[:space:]]*\[[[:space:]x-~]\][^*] ]]; then
    # Check if it's NOT marked [x]
    if [[ "$line" =~ ^[[:space:]]*-[[:space:]]*\[[[:space:]-~]\] ]]; then
      ALL_DONE=false
      break
    fi
  fi
done < <(find "$SPEC_PATH" -maxdepth 1 -name "tasks*.md" -type f -exec cat {} \;)

if [[ "$ALL_DONE" == false ]]; then
  exit 0
fi

# Step 3: All tasks are done, now scan for TODOs
FILES_MANIFEST="$SPEC_PATH/files-touched.md"
TODOS_FOUND=false
TODO_REPORT=""

if [[ -f "$FILES_MANIFEST" ]] && [[ -s "$FILES_MANIFEST" ]]; then
  # Scan only files listed in files-touched.md
  while IFS= read -r file_path; do
    if [[ -f "$file_path" ]]; then
      while IFS= read -r line_num line_content; do
        TODO_REPORT+="$file_path:$line_num: $line_content"$'\n'
        TODOS_FOUND=true
      done < <(grep -n "TODO:" "$file_path" || true)
    fi
  done < "$FILES_MANIFEST"
else
  # Fallback: scan src/ for TODOs
  while IFS= read -r match; do
    TODO_REPORT+="$match"$'\n'
    TODOS_FOUND=true
  done < <(grep -rn "TODO:" src/ 2>/dev/null || true)
fi

# Step 4: Report or finalize
if [[ "$TODOS_FOUND" == true ]]; then
  # TODOs found, report them
  echo "=== TODOs found in spec: $SPEC_NAME ==="
  echo "$TODO_REPORT"
  echo "=== End of TODOs ==="
  exit 0
fi

# Step 5: No TODOs, mark spec as done
rm -f "$ACTIVE_SPEC_FILE"

# Rename spec folder
NEW_NAME="$SPEC_PATH(done)"
if [[ ! -d "$NEW_NAME" ]]; then
  mv "$SPEC_PATH" "$NEW_NAME"
  rm -f ".kiro/specs/.active-spec"
  rm -rf "$SPEC_PATH"
fi

# Append to tasks-completed.md
COMPLETED_LOG=".kiro/specs/tasks-completed.md"
if [[ -f "$COMPLETED_LOG" ]]; then
  LAST_NUM=$(tail -1 "$COMPLETED_LOG" | grep -oE '^[0-9]+' || echo "0")
  NEXT_NUM=$((LAST_NUM + 1))
else
  NEXT_NUM=1
fi

echo "$NEXT_NUM. $SPEC_NAME" >> "$COMPLETED_LOG"
