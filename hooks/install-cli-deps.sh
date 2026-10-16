#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DATA_DIR="${CLAUDE_PLUGIN_DATA:-}"

# In dev mode (no CLAUDE_PLUGIN_DATA), deps are in the local node_modules
if [[ -z "$DATA_DIR" ]]; then
  exit 0
fi

CLI_PKG="$PLUGIN_ROOT/tools/cli/package.json"
CACHED_PKG="$DATA_DIR/cli-package.json"
CLI_NODE_MODULES="$PLUGIN_ROOT/tools/cli/node_modules"

# True only if the resolved node_modules exists AND every declared runtime
# dependency is actually present. `-d` follows the symlink, so a dangling or
# wiped target is correctly seen as absent. Dependency names come from the same
# package.json the marker is compared against, so this never drifts.
deps_present() {
  local node_modules="$1" pkg="$2"
  [[ -d "$node_modules" ]] || return 1
  local deps
  deps=$(node -e 'const p = require(process.argv[1]); process.stdout.write(Object.keys(p.dependencies || {}).join("\n"));' "$pkg" 2>/dev/null) || return 1
  local dep
  while IFS= read -r dep; do
    [[ -z "$dep" ]] && continue
    [[ -d "$node_modules/$dep" ]] || return 1
  done <<< "$deps"
  return 0
}

# Skip only if package.json is unchanged AND the deps are actually installed.
if diff -q "$CLI_PKG" "$CACHED_PKG" >/dev/null 2>&1 && deps_present "$CLI_NODE_MODULES" "$CLI_PKG"; then
  exit 0
fi

# Install deps into the data directory
cp "$CLI_PKG" "$DATA_DIR/package.json"
cd "$DATA_DIR"
if npm install --omit=dev; then
  cp "$CLI_PKG" "$CACHED_PKG"
else
  echo "Warning: Could not install CLI dependencies into $DATA_DIR." >&2
  echo "  Plugin CLI commands (validate-mermaid, render-diagrams, walkthrough, check-refs, PR monitor) will be unavailable until this succeeds." >&2
  echo "  Check that 'npm' and a supported Node (^22.22.2, ^24.15.0 or >=26) are on PATH and the registry is reachable. The next session will retry." >&2
  exit 0
fi

# Symlink so Node's ESM resolver finds deps via normal node_modules walk
ln -sfn "$DATA_DIR/node_modules" "$CLI_NODE_MODULES"
