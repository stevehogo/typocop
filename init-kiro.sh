#!/usr/bin/env bash
# install-kiro-workflow.sh
# Installs the .kiro workflow (steering, skills, hooks, settings) into a target project.
# Uses fzf for interactive multi-selection of components to install.
#
# Usage:
#   cd /path/to/target/project && /home/citado/typocop/install-kiro-workflow.sh

set -euo pipefail

SOURCE_DIR="/home/citado/typocop"
TARGET_DIR="$(pwd)"

if [[ "$SOURCE_DIR" == "$TARGET_DIR" ]]; then
  echo "❌ Target directory is the same as the source. Aborting."
  exit 1
fi

if ! command -v fzf &>/dev/null; then
  echo "❌ fzf is not installed. Install it with: sudo apt install fzf"
  exit 1
fi

echo "📦 Kiro workflow installer"
echo "   Source : $SOURCE_DIR"
echo "   Target : $TARGET_DIR"
echo ""

# ── Helpers ──────────────────────────────────────────────────────────────────

copy_dir() {
  local src="$SOURCE_DIR/$1"
  local dst="$TARGET_DIR/$1"

  if [[ ! -d "$src" ]]; then
    echo "   ⚠️  Skipping $1 (not found in source)"
    return
  fi

  mkdir -p "$dst"
  # Copy only files that don't exist in target
  rsync -av --ignore-existing "$src/" "$dst/"
  echo "   ✅ $1"
}

copy_hooks() {
  local src="$SOURCE_DIR/$1"
  local dst="$TARGET_DIR/$1"

  if [[ ! -d "$src" ]]; then
    echo "   ⚠️  Skipping $1 (not found in source)"
    return
  fi

  mkdir -p "$dst"
  # Copy only files that don't exist in target
  rsync -av --ignore-existing "$src/" "$dst/"
  echo "   ✅ $1"

  # Also copy scripts folder
  local scripts_src="$SOURCE_DIR/.kiro/scripts"
  local scripts_dst="$TARGET_DIR/.kiro/scripts"

  if [[ -d "$scripts_src" ]]; then
    mkdir -p "$scripts_dst"
    rsync -av --ignore-existing "$scripts_src/" "$scripts_dst/"
    echo "   ✅ .kiro/scripts (auto-copied with hooks)"
  fi
}

copy_file() {
  local src="$SOURCE_DIR/$1"
  local dst="$TARGET_DIR/$1"

  if [[ ! -f "$src" ]]; then
    echo "   ⚠️  Skipping $1 (not found in source)"
    return
  fi

  mkdir -p "$(dirname "$dst")"
  if [[ -f "$dst" ]]; then
    echo "   ⚠️  $1 already exists — skipped"
  else
    cp "$src" "$dst"
    echo "   ✅ $1"
  fi
}

merge_json() {
  local src="$SOURCE_DIR/$1"
  local dst="$TARGET_DIR/$1"

  if [[ ! -f "$src" ]]; then
    echo "   ⚠️  Skipping $1 (not found in source)"
    return
  fi

  if [[ -f "$dst" ]]; then
    echo "   ⚠️  $1 already exists — skipped (merge manually if needed)"
    echo "       Source: $src"
  else
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    echo "   ✅ $1"
  fi
}

# ── Component definitions ─────────────────────────────────────────────────────
# Format: "label|action|arg"
declare -A COMPONENT_ACTIONS=(
  ["📝 Steering files"]="copy_dir|.kiro/steering"
  ["🧠 Skills"]="copy_dir|.kiro/skills"
  ["🪝 Hooks (active)"]="copy_hooks|.kiro/hooks"
  ["⚙️  Settings — mcp.json"]="merge_json|.kiro/settings/mcp.json"
  ["⚙️  Settings — lsp.json"]="merge_json|.kiro/settings/lsp.json"
)

COMPONENT_LABELS=(
  "📝 Steering files"
  "🧠 Skills"
  "🪝 Hooks (active)"
  "⚙️  Settings — mcp.json"
  "⚙️  Settings — lsp.json"
)

# ── fzf selection ─────────────────────────────────────────────────────────────
echo "Select components to install (TAB to multi-select, ENTER to confirm):"
echo ""

SELECTED=$(printf '%s\n' "${COMPONENT_LABELS[@]}" | \
  fzf --multi \
      --prompt="Install > " \
      --header="TAB = toggle selection | ENTER = confirm" \
      --bind "ctrl-a:select-all" \
      --ansi)

if [[ -z "$SELECTED" ]]; then
  echo "Nothing selected. Aborting."
  exit 0
fi

echo ""
echo "Installing selected components..."
echo ""

# ── Install selected ──────────────────────────────────────────────────────────
while IFS= read -r label; do
  entry="${COMPONENT_ACTIONS[$label]}"
  action="${entry%%|*}"
  arg="${entry##*|}"
  echo "→ $label"
  "$action" "$arg"
  echo ""
done <<< "$SELECTED"

# ── Done ─────────────────────────────────────────────────────────────────────
echo "✅ Done. Kiro workflow installed into: $TARGET_DIR"
echo ""
echo "Next steps:"
echo "  1. Review .kiro/steering/ and remove any project-specific files"
echo "  2. Check .kiro/settings/mcp.json if it was skipped (manual merge needed)"
echo "  3. Open the project in Kiro — hooks and steering activate automatically"
