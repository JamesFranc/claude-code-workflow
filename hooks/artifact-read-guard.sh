#!/bin/bash
# PreToolUse guard (Read): a Read of an image or PDF artifact is blocked in a durable context (FLOW-246).
# A Read of one is re-sent on every later request in the session, so it is looked at by a disposable
# artifact-viewer subagent that reports back in words. Exempt: the viewer's own agent_type together
# with an agent_id, which only a subagent's tool calls carry — a durable session started with
# `--agent workflow:artifact-viewer` sets agent_type alone and stays blocked.

set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

INPUT=$(cat)
FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || FILE_PATH=""
AGENT_TYPE=$(printf '%s' "$INPUT" | jq -r '.agent_type // empty' 2>/dev/null) || AGENT_TYPE=""
AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id // empty' 2>/dev/null) || AGENT_ID=""

if [[ -n "$AGENT_ID" && ( "$AGENT_TYPE" == "artifact-viewer" || "$AGENT_TYPE" == *":artifact-viewer" ) ]]; then
  exit 0
fi

shopt -s nocasematch
if [[ ! "$FILE_PATH" =~ \.(png|jpe?g|gif|webp|bmp|tiff?|ico|heic|avif|pdf)$ ]]; then
  exit 0
fi

cat >&2 <<EOF
Reading ${FILE_PATH} is blocked: an image or PDF artifact read here is re-sent on every later
request in this session. Hand the path and the one question you need answered to the
artifact-viewer agent (agents/artifact-viewer.md) and use its report instead
(skills/workflow-guide/references/routing.md §Artifact Delegation).
EOF
exit 2
