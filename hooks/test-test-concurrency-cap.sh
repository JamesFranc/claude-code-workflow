#!/usr/bin/env bash
# Pins the test-runner concurrency ceiling test-concurrency/cap.ts resolves (FLOW-326).
#
# Node's --test defaults --test-concurrency to os.availableParallelism() - 1.
# Every agent worktree runs this same script, so an inherited default means each
# concurrent session sizes its test fan-out to the whole machine. cap.ts's capFor
# is the fix. This file pins capFor's own outputs and pins that print-cap.ts and
# report-cap.ts each emit exactly what capFor returns; it does not run, and
# cannot observe, whether tools/cli/package.json's test script actually wires
# print-cap.ts into --test-concurrency.
#
# It is a ceiling, not a pin, and that distinction is the reason this file was
# rewritten. A flat --test-concurrency=4 bounded an 18-core dev host and raised
# CI's 2-core runner from 1 worker to 4, where a wall-clock ratio test in
# check-refs tipped over on the contention. The shipped default is
# min(4, max(1, availableParallelism() - 1)): it bounds the large host, leaves
# the small one exactly as Node found it, and never resolves to zero workers.
#
# Assertions, in the order they run: capFor maps four constructed core counts
# to their pinned widths (a9-a12); a print-cap.ts that only calls capFor really
# does emit what capFor returns (a21); the module ci.yml's reporting step runs
# resolves the cap capFor gives for the width it reports, so the CI control
# cannot disagree with the cap it reports (a16); and that module reports this
# host's real width and resolves its cap through capFor (a22/a23).
#
# First: a22 is host-dependent, like everything here that reads a real width.
# A width hardcoded to THIS host's 18 satisfies a22 locally, and a23 cannot
# catch it either -- its stub's capFor ignores the argument it is given, so a23
# proves the value flows through capFor without proving the argument is real.
# Only a run on a different host catches it: CI's 2-core runner would report
# the hardcoded 18 against that host's real width of 2, and a22 would fail.
# It is not a guarantee that the number was measured, only that it matches on
# this run.
#
# Second: a21 and a23 run a module against a stub, so a module written to notice
# the stub defeats it -- returning capFor's value when it sees the sentinel and
# a constant otherwise passes every assertion here while shipping the constant.
# That is sabotage, not the debug edit a21 exists to catch, and no in-process
# check can rule it out: any of them can be detected by the code under test.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
CLI_DIR="${REPO_ROOT}/tools/cli"
CAP_MODULE="${CLI_DIR}/src/test-concurrency/cap.ts"
EXPECTED_CEILING=4
PRINT_CAP_MODULE="${CLI_DIR}/src/test-concurrency/print-cap.ts"
REPORT_CAP_MODULE="${CLI_DIR}/src/test-concurrency/report-cap.ts"

# a21 and a23 both need a module run against a cap.ts whose capFor returns a
# sentinel: what the module then emits proves the call actually happened, which
# no amount of reading the source can establish. One copy, so the two cannot
# drift apart.
CAP_SENTINEL=9973
run_against_cap_stub() {
    local module="$1" dir base rc
    base="$(basename "$module")"
    dir="$(mktemp -d)"
    cp "$module" "${dir}/${base}"
    cat > "${dir}/cap.ts" <<STUB
export const CONCURRENCY_CEILING = ${CAP_SENTINEL}
export const capFor = (_available: number): number => ${CAP_SENTINEL}
STUB
    (cd "$dir" && node --experimental-transform-types "$base")
    rc=$?
    rm -rf "$dir"
    return "$rc"
}

# Node warns about the experimental flag on every run, so that is not an error.
stub_stderr_of() {
    grep -vE 'ExperimentalWarning|trace-warnings' "$1" | grep -v '^[[:space:]]*$'
    rm -f "$1"
}

PASS=0
FAIL=0

check() {
    local description="$1"
    local actual="$2"
    local expected="$3"

    if [[ "$actual" == "$expected" ]]; then
        echo "PASS: ${description}"
        PASS=$((PASS + 1))
    else
        echo "FAIL: ${description} (expected '${expected}', got '${actual}')"
        FAIL=$((FAIL + 1))
    fi
}

fail_fast() {
    echo "FAIL: $1"
    FAIL=$((FAIL + 1))
    echo
    echo "test-concurrency-cap: ${PASS} passed, ${FAIL} failed"
    exit 1
}

echo "=== Test Concurrency Cap ==="
echo

# a9-a12: capFor at inputs chosen here, not read from the host. 5 is the
# smallest core count the ceiling binds on; 2 is CI's runner, the case a flat
# cap of 4 got wrong; 1 is where a naive availableParallelism()-1 returns 0.
cap_table="$(node --experimental-transform-types -e "
import(process.argv[1]).then(m => {
  const os = require('node:os');
  for (const n of [1, 2, 5, 18, os.availableParallelism()]) console.log(n + ' ' + m.capFor(n));
  console.log('host ' + os.availableParallelism());
});
" "$CAP_MODULE" 2>/dev/null)"
cap_of() { printf '%s\n' "$cap_table" | awk -v n="$1" '$1 == n { print $2 }' | head -1; }

check "capFor(1) is 1 worker, never 0" "$(cap_of 1)" "1"
check "capFor(2) is 1 worker, CI's runner left as Node found it" "$(cap_of 2)" "1"
check "capFor(5) is ${EXPECTED_CEILING}, the smallest host the ceiling binds on" "$(cap_of 5)" "$EXPECTED_CEILING"
check "capFor(18) is ${EXPECTED_CEILING}, this dev host bounded" "$(cap_of 18)" "$EXPECTED_CEILING"

# host_width backs a22 below: this host's real core count, printed by the
# same node subprocess above as "host N" via os.availableParallelism()
# directly, not asked for again separately.
host_width="$(printf '%s\n' "$cap_table" | awk '$1 == "host" { print $2 }' | head -1)"
if [[ -z "$host_width" || -z "$(cap_of "$host_width")" ]]; then
    fail_fast "could not read this host's width, or capFor's cap for it, from the cap.ts subprocess (cap_table: ${cap_table})"
fi

# a21: run print-cap.ts against a stub cap.ts whose capFor returns a sentinel,
# and require the emitted value to be that sentinel, so a print-cap.ts that
# emits a constant instead of capFor's result fails.
#
# The stub's capFor ignores its argument, so a hardcoded capFor(18) returns the
# sentinel exactly as the real call does -- measured with an argument-echoing
# stub, both emit the same value on this host. a21 proves the value flows
# through capFor; it does not prove the argument passed is the host's real
# width.
#
# The sentinel is not a plausible core count or ceiling, so no spelling that
# emits a real width or cap can satisfy it by coincidence.
stub_stderr="$(mktemp)"
stubbed_cap="$(run_against_cap_stub "$PRINT_CAP_MODULE" 2>"$stub_stderr")"
stub_errors="$(stub_stderr_of "$stub_stderr")"
if [[ -n "$stub_errors" ]]; then
    echo "FAIL: print-cap.ts does not run against a stubbed cap.ts, so nothing here can observe what it emits: ${stub_errors}"
    FAIL=$((FAIL + 1))
else
    check "print-cap.ts emits whatever capFor returns, not a value of its own" "$stubbed_cap" "$CAP_SENTINEL"
fi

# a16: the control cannot disagree with what it controls. Runs the module ci.yml
# runs and checks its resolvedCap against capFor for the width it reported.
report_output="$(node --experimental-transform-types "$REPORT_CAP_MODULE" 2>/dev/null)"
reported_available="$(printf '%s\n' "$report_output" | sed -n 's/^availableParallelism: \([0-9][0-9]*\)$/\1/p')"
reported_cap="$(printf '%s\n' "$report_output" | sed -n 's/^resolvedCap: \([0-9][0-9]*\)$/\1/p')"
# Both empty would make the comparison below compare "" with "" and pass, so the
# shape is asserted before the values are.
if [[ -z "$reported_available" || -z "$reported_cap" ]]; then
    fail_fast "report-cap.ts did not print both labelled numbers, so a16 has nothing to compare (got: ${report_output})"
fi
check "report-cap.ts resolves the cap capFor gives for its reported ${reported_available}-core host" "$reported_cap" "$(cap_of "$reported_available")"

# a16 only asks whether the two numbers this module prints agree
# with EACH OTHER, which a module printing two fixed numbers does perfectly --
# so `availableParallelism: 18, resolvedCap: 4` hardcoded satisfied it, and
# would print a fabricated 18 on CI's 2-core runner. A core count nobody
# measured is the root cause this whole ticket traces back to, and it was left
# live in the one artifact people open to find out what the cap really is.
#
# a16 already compares resolvedCap against capFor of the width the module
# itself reported. a22-a23 close what a16 cannot see; a16 closes what they
# cannot.

# a22: the width it reports is this host's real width, not one it carries.
check "report-cap.ts reports this host's real width" "$reported_available" "$host_width"

# a23: and its cap is whatever capFor returns -- execution, not agreement.
report_stub_stderr="$(mktemp)"
stubbed_report="$(run_against_cap_stub "$REPORT_CAP_MODULE" 2>"$report_stub_stderr")"
report_stub_errors="$(stub_stderr_of "$report_stub_stderr")"
if [[ -n "$report_stub_errors" ]]; then
    echo "FAIL: report-cap.ts does not run against a stubbed cap.ts, so nothing here can observe its cap: ${report_stub_errors}"
    FAIL=$((FAIL + 1))
else
    stubbed_report_cap="$(printf '%s\n' "$stubbed_report" | sed -n 's/^resolvedCap: \([0-9][0-9]*\)$/\1/p')"
    check "report-cap.ts's cap is whatever capFor returns, not a value of its own" "$stubbed_report_cap" "$CAP_SENTINEL"
fi

echo
echo "test-concurrency-cap: ${PASS} passed, ${FAIL} failed"

if [[ ${FAIL} -gt 0 ]]; then
    exit 1
fi
