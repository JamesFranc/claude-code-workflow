#!/bin/bash
# PreToolUse guard (AskUserQuestion): blocks only when a board is available (FLOW-148, FLOW-415).
# With a board, the tool would bypass it, so a question goes on the board instead. With no board the
# terminal is where questions are asked, and this tool is a natural way to ask one. The probe passes
# a fixed session id because `session status` refuses without one and the hook's own environment may
# carry none; availability does not depend on which id it is. If the probe itself fails, the guard
# blocks as it did before FLOW-415: a prose question still works.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DASHBOARD="${PLUGIN_ROOT}/bin/dashboard"

board_available="$("$DASHBOARD" session status --session askuserquestion-guard --json 2>/dev/null | jq -r '.dashboardAvailable' 2>/dev/null)"
probe_rc=$?

if [ "$probe_rc" -eq 0 ] && [ "$board_available" = "false" ]; then
  exit 0
fi

cat >&2 <<'MSG'
AskUserQuestion is disabled while a board is available.

A question for the user goes on the board, or it is not asked at all: decide it and keep working.
If it is the user's (a decision on a bright line, an unsettled teammate disagreement, or a fact only
they hold), post it first
(dashboard item add --type question --recommend "<one line>" --stalls "<what waits|none>" --why-mine "<taste|scope|risk|teammate-unsettled|fact>" --prompt "...")
— see skills/board/references/escalation-contract.md and skills/board/references/dashboard-protocol.md.
MSG
exit 2
