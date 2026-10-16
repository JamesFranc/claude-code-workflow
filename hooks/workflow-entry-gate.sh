#!/bin/bash
# PreToolUse gate (Edit/Write): blocks file edits when this session has no recorded workflow
# entry and no logged bypass. State-keyed, not branch-keyed — closes the gap where any feature
# branch bypassed branch-setup.sh entirely (FLOW-147).

set -euo pipefail

# jq failing (missing binary, non-JSON stdin) must not trip `set -e` before the empty-guard
# below gets a chance to fail OPEN (FLOW-147 review m6; guard structure hardened FLOW-183).
INPUT=$(cat)
if command -v jq >/dev/null 2>&1; then
  SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || SESSION_ID=""
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.filePath // empty' 2>/dev/null) || FILE_PATH=""
else
  SESSION_ID=""
  FILE_PATH=""
fi

if [[ -z "$FILE_PATH" || -z "$SESSION_ID" ]]; then
  exit 0
fi

if [[ ! "$FILE_PATH" = /* ]]; then
  FILE_PATH="$(pwd)/$FILE_PATH"
fi

# A Write into a not-yet-existing directory means `dirname "$FILE_PATH"` doesn't exist either —
# `cd` into it would fail, REPO_ROOT would come back empty, and the non-repo carve-out below
# would wrongly let the edit through. Walk up to the nearest EXISTING ancestor first (FLOW-147).
EXISTING_DIR="$(dirname "$FILE_PATH")"
while [[ ! -d "$EXISTING_DIR" && "$EXISTING_DIR" != "/" ]]; do
  EXISTING_DIR="$(dirname "$EXISTING_DIR")"
done

# Carve-out: not inside a git repo (scratchpads, memory dirs, one-off temp files)
REPO_ROOT=$(cd "$EXISTING_DIR" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null) || true
if [[ -z "$REPO_ROOT" ]]; then
  exit 0
fi

# Carve-out: gitignored files (docs/plans/ in this repo, generated files, local scratch)
if git -C "$REPO_ROOT" check-ignore -q -- "$FILE_PATH" 2>/dev/null; then
  exit 0
fi

# Carve-out: workflow docs are written BY the entry skills — never gate them, tracked or not
if [[ "$FILE_PATH" == */docs/plans/* ]]; then
  exit 0
fi

# Carve-out: local-only repo (no remote) — personal notes and tracking that never ship through a
# PR. branch-setup.sh exempts the same repos (FLOW-396)
if [[ -z "$(git -C "$REPO_ROOT" remote 2>/dev/null)" ]]; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Exit contract with the CLI: 0 = allow, 3 = no workflow (block). Any OTHER non-zero is an
# infra failure (node missing, crash) — fail OPEN so a broken CLI can never brick all edits.
set +e
"${PLUGIN_ROOT}/bin/workflow-state" check --session "$SESSION_ID" >/dev/null 2>&1
CHECK_RC=$?
set -e

if [[ "$CHECK_RC" -eq 3 ]]; then
  cat >&2 <<EOF
WORKFLOW ENTRY REQUIRED

You're about to edit: $FILE_PATH
No workflow has been entered in this session.

Enter the matching workflow first — it records the entry marker automatically:
- Quick Change (workflow:quick-change) for small, well-understood changes
- Systematic Debugging (workflow:systematic-debugging) for bugs
- JTBD (workflow:jtbd) for substantial new work

If the user has explicitly authorized working outside the workflow, record a logged exception:
  ${PLUGIN_ROOT}/bin/workflow-state bypass --reason "<why>" --session "$SESSION_ID"
EOF
  exit 2
fi

exit 0
