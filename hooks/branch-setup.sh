#!/bin/bash
# Pre-edit hook: Ensures proper branch setup before any file modifications
#
# This hook intercepts Edit and Write tool calls and checks if the target
# repo has been properly set up with a feature branch. If not, it blocks
# and requests the branch-setup skill be invoked.

set -euo pipefail

# Read hook input from stdin
INPUT=$(cat)

# Extract the file path being edited. Guarded (FLOW-183): under `set -e`, an unguarded assignment
# from a failing/missing jq would abort the script before any of its intentional fail-open paths.
if command -v jq >/dev/null 2>&1; then
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.filePath // empty' 2>/dev/null) || FILE_PATH=""
else
  FILE_PATH=""
fi

if [[ -z "$FILE_PATH" ]]; then
  exit 0  # No file path, allow
fi

# Resolve to absolute path
if [[ ! "$FILE_PATH" = /* ]]; then
  FILE_PATH="$(pwd)/$FILE_PATH"
fi

# Find the git repo root for this file
REPO_ROOT=$(cd "$(dirname "$FILE_PATH")" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null) || true

if [[ -z "$REPO_ROOT" ]]; then
  exit 0  # Not in a git repo, allow
fi

# Check current branch
CURRENT_BRANCH=$(cd "$REPO_ROOT" && git rev-parse --abbrev-ref HEAD 2>/dev/null) || true

if [[ -z "$CURRENT_BRANCH" ]]; then
  exit 0  # Can't determine branch, allow
fi

# Check if repo has a remote (local-only repos don't need branches)
HAS_REMOTE=$(cd "$REPO_ROOT" && git remote 2>/dev/null | head -1) || true

if [[ -z "$HAS_REMOTE" ]]; then
  # Local-only repo - allow edits but remind to merge back to main when done
  cat >&2 <<EOF
LOCAL REPO REMINDER: $REPO_ROOT has no remote. When finished, immediately merge your changes to main and switch back: git checkout main && git merge "<branch>"
EOF
  exit 0
fi

# Allow edits to gitignored files (e.g., docs/plans/) on any branch
if cd "$REPO_ROOT" && git check-ignore -q "$FILE_PATH" 2>/dev/null; then
  exit 0
fi

# If on main/master with a remote, block and request branch setup
if [[ "$CURRENT_BRANCH" == "main" || "$CURRENT_BRANCH" == "master" ]]; then
  cat >&2 <<EOF
BRANCH SETUP REQUIRED

You're about to edit files in: $REPO_ROOT
Current branch: $CURRENT_BRANCH

Before making changes, please set up a feature branch.
Use the branch-setup skill: /branch-setup

Or provide a ticket number (e.g., DEV-1234) and I'll create the branch.
EOF
  exit 2  # Block the tool call
fi

# Not on main, allow the edit
exit 0
