#!/usr/bin/env bash
# track-active-spec.sh
# Called on preTaskExecution event.
# Extracts the spec folder from the task file path provided via stdin JSON,
# then writes it to .kiro/specs/.active-spec for other hooks to use.

# Read stdin with a short timeout — preTaskExecution passes task context as JSON
STDIN_DATA=$(timeout 2 cat 2>/dev/null || true)

spec_path=""

# Try to extract taskFilePath from the JSON payload
if [[ -n "$STDIN_DATA" ]]; then
  spec_path=$(echo "$STDIN_DATA" | python3 -c "
import sys, json, os
try:
    data = json.load(sys.stdin)
    # preTaskExecution provides taskFilePath (e.g. .kiro/specs/my-spec/tasks.md)
    task_file = data.get('taskFilePath') or data.get('specPath') or ''
    if task_file:
        # Return the directory containing the tasks file
        print(os.path.dirname(task_file))
except Exception:
    pass
" 2>/dev/null || true)
fi

# Fallback: scan for the spec with the most recently changed in-progress task
if [[ -z "$spec_path" ]]; then
  # Find the tasks.md most recently modified that has an in-progress [-] task
  while IFS= read -r -d '' tasks_file; do
    if grep -qE '^\s*-\s*\[-\]' "$tasks_file" 2>/dev/null; then
      spec_path="${tasks_file%/tasks*}"
      break
    fi
  done < <(find .kiro/specs -maxdepth 2 -name "tasks*.md" -print0 2>/dev/null \
    | xargs -0 ls -t 2>/dev/null \
    | tr '\n' '\0' \
    | head -z -n 20)
fi

# Fallback: queued [~] tasks
if [[ -z "$spec_path" ]]; then
  while IFS= read -r -d '' tasks_file; do
    if grep -qE '^\s*-\s*\[~\]' "$tasks_file" 2>/dev/null; then
      spec_path="${tasks_file%/tasks*}"
      break
    fi
  done < <(find .kiro/specs -maxdepth 2 -name "tasks*.md" -print0 2>/dev/null)
fi

if [[ -n "$spec_path" ]]; then
  echo "$spec_path" > ".kiro/specs/.active-spec"
else
  rm -f ".kiro/specs/.active-spec"
fi

exit 0
