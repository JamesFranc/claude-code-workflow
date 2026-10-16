#!/usr/bin/env bash
# Runs the wake mod's tests (hooks/*.test.ts) under `claude plugin test`.
#
# `claude plugin test <dir>` runs every *.test.ts under <dir> with no filter, so pointing it at the
# repo root would also run tools/cli's node:test files, which cannot load in the mod runtime. It
# runs against a copy holding only the manifest and hooks/ instead.
#
# Not wired into `pnpm test`: CI has no `claude` binary. The mod-test gate runs it locally.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
CLAUDE_BIN="${CLAUDE_CODE_EXECPATH:-claude}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -R "${REPO_ROOT}/.claude-plugin" "${REPO_ROOT}/hooks" "$work/"
"$CLAUDE_BIN" plugin test "$work"
