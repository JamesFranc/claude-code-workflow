#!/bin/bash
# Test script for install-cli-deps.sh
# Drives the hook against constructed PLUGIN_ROOT / DATA_DIR states with a
# stubbed npm, and verifies the skip-vs-reinstall decision and failure handling.

set -uo pipefail

HOOK_SCRIPT="$(cd "$(dirname "$0")" && pwd)/install-cli-deps.sh"
REAL_CLI_PKG="$(cd "$(dirname "$0")/.." && pwd)/tools/cli/package.json"
PASS=0
FAIL=0

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# --- npm stubs -------------------------------------------------------------
# A fake `npm` whose `install` creates the expected node_modules layout in the
# current directory (the hook cd's into DATA_DIR first) and records that it ran.
STUB_OK_DIR="$TMP_ROOT/stub-ok"
mkdir -p "$STUB_OK_DIR"
cat > "$STUB_OK_DIR/npm" <<STUB
#!/bin/bash
if [[ "\$1" == "install" ]]; then
  touch "\$NPM_CALLED_SENTINEL"
  mkdir -p node_modules/@stricli/core node_modules/mermaid node_modules/jsdom node_modules/ts-pattern \\
           node_modules/@terrastruct/d2 node_modules/sharp node_modules/@iconify-json/lucide node_modules/gsap
fi
exit 0
STUB
chmod +x "$STUB_OK_DIR/npm"

# A fake `npm` whose `install` fails (records the call, exits non-zero).
STUB_FAIL_DIR="$TMP_ROOT/stub-fail"
mkdir -p "$STUB_FAIL_DIR"
cat > "$STUB_FAIL_DIR/npm" <<STUB
#!/bin/bash
if [[ "\$1" == "install" ]]; then
  touch "\$NPM_CALLED_SENTINEL"
  exit 1
fi
exit 0
STUB
chmod +x "$STUB_FAIL_DIR/npm"

# --- helpers ---------------------------------------------------------------
# Fresh PLUGIN_ROOT (with the real package.json) and empty DATA_DIR per case.
make_case_dirs() {
  local case_dir="$TMP_ROOT/case-$1"
  rm -rf "$case_dir"
  mkdir -p "$case_dir/plugin/tools/cli" "$case_dir/data"
  cp "$REAL_CLI_PKG" "$case_dir/plugin/tools/cli/package.json"
  echo "$case_dir"
}

# Run the hook for a case. Args: <case-dir> <stub-dir> [devmode]
# Prints nothing; sets globals HOOK_EXIT and NPM_CALLED (0/1).
run_hook() {
  local case_dir="$1" stub_dir="$2" devmode="${3:-}"
  local sentinel="$case_dir/npm-called"
  rm -f "$sentinel"
  HOOK_EXIT=0
  if [[ "$devmode" == "devmode" ]]; then
    CLAUDE_PLUGIN_ROOT="$case_dir/plugin" CLAUDE_PLUGIN_DATA="" \
      NPM_CALLED_SENTINEL="$sentinel" PATH="$stub_dir:$PATH" \
      bash "$HOOK_SCRIPT" >/dev/null 2>&1 || HOOK_EXIT=$?
  else
    CLAUDE_PLUGIN_ROOT="$case_dir/plugin" CLAUDE_PLUGIN_DATA="$case_dir/data" \
      NPM_CALLED_SENTINEL="$sentinel" PATH="$stub_dir:$PATH" \
      bash "$HOOK_SCRIPT" >/dev/null 2>&1 || HOOK_EXIT=$?
  fi
  [[ -f "$sentinel" ]] && NPM_CALLED=1 || NPM_CALLED=0
}

assert() {
  local description="$1" condition="$2"
  if [[ "$condition" == "true" ]]; then
    echo "PASS: $description"; PASS=$((PASS + 1))
  else
    echo "FAIL: $description"; FAIL=$((FAIL + 1))
  fi
}

echo "=== install-cli-deps Hook Tests ==="
echo

# A. Fresh install: no marker, no symlink -> installs, writes marker + symlink.
CD=$(make_case_dirs A)
run_hook "$CD" "$STUB_OK_DIR"
assert "fresh: npm install ran"          "$([[ $NPM_CALLED -eq 1 ]] && echo true || echo false)"
assert "fresh: marker written"           "$([[ -f "$CD/data/cli-package.json" ]] && echo true || echo false)"
assert "fresh: symlink created"          "$([[ -L "$CD/plugin/tools/cli/node_modules" ]] && echo true || echo false)"

# B. Up-to-date: marker matches, symlink resolves, deps present -> SKIP.
CD=$(make_case_dirs B)
cp "$CD/plugin/tools/cli/package.json" "$CD/data/cli-package.json"
mkdir -p "$CD/data/node_modules/@stricli/core" "$CD/data/node_modules/mermaid" \
         "$CD/data/node_modules/jsdom" "$CD/data/node_modules/ts-pattern" \
         "$CD/data/node_modules/@terrastruct/d2" "$CD/data/node_modules/sharp" \
         "$CD/data/node_modules/@iconify-json/lucide" "$CD/data/node_modules/gsap"
ln -sfn "$CD/data/node_modules" "$CD/plugin/tools/cli/node_modules"
run_hook "$CD" "$STUB_OK_DIR"
assert "up-to-date: npm install did NOT run" "$([[ $NPM_CALLED -eq 0 ]] && echo true || echo false)"

# C. THE BUG: marker matches, symlink exists but target wiped (dangling) -> REINSTALL.
CD=$(make_case_dirs C)
cp "$CD/plugin/tools/cli/package.json" "$CD/data/cli-package.json"
mkdir -p "$CD/data/node_modules/mermaid"
ln -sfn "$CD/data/node_modules" "$CD/plugin/tools/cli/node_modules"
rm -rf "$CD/data/node_modules"   # symlink now dangling
run_hook "$CD" "$STUB_OK_DIR"
assert "dangling symlink: npm install ran (self-heal)" "$([[ $NPM_CALLED -eq 1 ]] && echo true || echo false)"

# D. Partial install: symlink resolves but a declared dep dir is missing -> REINSTALL.
CD=$(make_case_dirs D)
cp "$CD/plugin/tools/cli/package.json" "$CD/data/cli-package.json"
mkdir -p "$CD/data/node_modules/@stricli/core" "$CD/data/node_modules/mermaid" \
         "$CD/data/node_modules/jsdom"   # ts-pattern intentionally missing
ln -sfn "$CD/data/node_modules" "$CD/plugin/tools/cli/node_modules"
run_hook "$CD" "$STUB_OK_DIR"
assert "partial deps: npm install ran (self-heal)" "$([[ $NPM_CALLED -eq 1 ]] && echo true || echo false)"

# E. Changed package.json: marker differs -> REINSTALL.
CD=$(make_case_dirs E)
echo '{"dependencies":{"old":"1.0.0"}}' > "$CD/data/cli-package.json"
mkdir -p "$CD/data/node_modules/@stricli/core" "$CD/data/node_modules/mermaid" \
         "$CD/data/node_modules/jsdom" "$CD/data/node_modules/ts-pattern" \
         "$CD/data/node_modules/@terrastruct/d2" "$CD/data/node_modules/sharp" \
         "$CD/data/node_modules/@iconify-json/lucide" "$CD/data/node_modules/gsap"
ln -sfn "$CD/data/node_modules" "$CD/plugin/tools/cli/node_modules"
run_hook "$CD" "$STUB_OK_DIR"
assert "changed package.json: npm install ran" "$([[ $NPM_CALLED -eq 1 ]] && echo true || echo false)"

# F. Dev mode: no CLAUDE_PLUGIN_DATA -> early exit, no install.
CD=$(make_case_dirs F)
run_hook "$CD" "$STUB_OK_DIR" devmode
assert "dev mode: npm install did NOT run"  "$([[ $NPM_CALLED -eq 0 ]] && echo true || echo false)"
assert "dev mode: exit 0"                   "$([[ $HOOK_EXIT -eq 0 ]] && echo true || echo false)"

# G. Install failure: fake npm exits 1 -> hook exits 0, marker NOT written (retry next run).
CD=$(make_case_dirs G)
run_hook "$CD" "$STUB_FAIL_DIR"
assert "install failure: hook exits 0 (non-blocking)" "$([[ $HOOK_EXIT -eq 0 ]] && echo true || echo false)"
assert "install failure: marker NOT written"          "$([[ ! -f "$CD/data/cli-package.json" ]] && echo true || echo false)"

echo
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -gt 0 ]] && exit 1
exit 0
