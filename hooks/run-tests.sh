#!/usr/bin/env bash
# Runs every hooks/test-*.sh and aggregates the results.
#
# Wired into `pnpm test`, which is what CI runs — before this existed the hook
# tests only ran when someone invoked them by hand, so a hook regression shipped
# green. Adding a test-<name>.sh beside a hook is now enough to have CI run it.

set -uo pipefail

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

passed=0
failed=0
failed_names=()

shopt -s nullglob
tests=("$HOOKS_DIR"/test-*.sh)
shopt -u nullglob

# An empty glob must fail loudly. A runner that finds nothing and reports success
# is indistinguishable from a green suite, which is the failure this file exists
# to prevent.
if [[ ${#tests[@]} -eq 0 ]]; then
    echo "hooks/run-tests.sh: no hook tests found in ${HOOKS_DIR}" >&2
    exit 1
fi

for test_path in "${tests[@]}"; do
    test_name="$(basename "$test_path")"
    echo "── ${test_name}"
    if bash "$test_path"; then
        passed=$((passed + 1))
    else
        failed=$((failed + 1))
        failed_names+=("$test_name")
    fi
    echo
done

echo "hook tests: ${passed} passed, ${failed} failed"

if [[ ${failed} -gt 0 ]]; then
    printf 'failed: %s\n' "${failed_names[*]}" >&2
    exit 1
fi
