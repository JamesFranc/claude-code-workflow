#!/usr/bin/env bash
# Tests bin/test-lock (FLOW-420): agents run by one user take turns running tests.
#
# Every case sets TEST_LOCK_ROOT to its own temp dir, so it exercises the real directory creation and
# ownership check without touching this user's real lock, and neither waits on nor blocks another
# agent's tests. TEST_LOCK_HELD is cleared first: this suite itself normally runs under test-lock, and
# an inherited TEST_LOCK_HELD would make every case below skip the lock entirely and pass without
# testing it.
#
# Each platform exercises only its own locker: flock on Linux (CI), /usr/bin/lockf on macOS.
#
# A channel (stdout, stderr) is compared as raw bytes: each is written to a file and compared with
# cmp, so a missing or extra trailing newline fails.

set -uo pipefail
unset TEST_LOCK_HELD CLAUDE_CODE_SESSION_ID TEST_LOCK_ROOT TEST_LOCK_BEAT_SECONDS TEST_LOCK_DASHBOARD

TEST_LOCK="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)/bin/test-lock"
TMP_ROOT="$(mktemp -d)"
LOCK_DIR_NAME="claude-agent-tests-$(id -u)"
PASS=0
FAIL=0

main() {
    trap cleanup EXIT
    case_free_lock_runs_the_command
    case_second_run_waits_for_the_first
    case_killed_holder_frees_the_lock
    case_terminating_test_lock_stops_the_command
    case_interrupting_test_lock_stops_the_command
    case_beats_while_waiting_and_running
    case_beat_flag_names_the_session
    case_killed_test_lock_stops_beating
    case_no_session_no_beat
    case_nested_call_runs_directly
    case_status_names_the_holder
    case_stdin_reaches_the_command
    case_unrunnable_command_exits_like_a_shell
    case_unopenable_lock_runs_unlocked
    case_symlinked_lock_dir_runs_unlocked
    case_failed_wait_keeps_the_holder_record
    case_usage_errors
    echo "test-lock: ${PASS} passed, ${FAIL} failed"
    [[ ${FAIL} -eq 0 ]]
}

case_free_lock_runs_the_command() {
    local dir="${TMP_ROOT}/free" rc
    mkdir -p "$dir"
    TEST_LOCK_ROOT="$dir" "$TEST_LOCK" -- bash -c 'echo "$TEST_LOCK_HELD" > "$1"; echo out; exit 7' _ "${dir}/held" >"${dir}/out" 2>"${dir}/err"
    rc=$?
    check "free: exits with the command's exit code" "7" "$rc"
    printf 'out\n' > "${dir}/out.expected"
    same_bytes "free: stdout is the command's, byte for byte" "${dir}/out.expected" "${dir}/out"
    printf 'test-lock: lock free — running\ntest-lock: released after Ns, exit 7\n' > "${dir}/err.expected"
    normalise < "${dir}/err" > "${dir}/err.normalised"
    same_bytes "free: stderr is the lock's transcript" "${dir}/err.expected" "${dir}/err.normalised"
    check "free: sets TEST_LOCK_HELD for the command" "1" "$(cat "${dir}/held")"
    check "free: creates the lock directory private to the user" "drwx------" "$(ls -ld "${dir}/${LOCK_DIR_NAME}" | cut -c1-10)"
}

case_second_run_waits_for_the_first() {
    local dir="${TMP_ROOT}/serial" log a_pid
    mkdir -p "$dir"
    log="${dir}/order"
    TEST_LOCK_ROOT="$dir" "$TEST_LOCK" -- bash -c 'echo a-start >> "$1"; sleep 3; echo a-end >> "$1"' _ "$log" 2>/dev/null &
    a_pid=$!
    track "$a_pid"
    wait_for "serial: first run started" 30 test -s "$log" || return
    TEST_LOCK_ROOT="$dir" "$TEST_LOCK" -- bash -c 'echo b >> "$1"' _ "$log" >"${dir}/b-out" 2>"${dir}/b-err"
    check "serial: second run exits 0" "0" "$?"
    wait "$a_pid"
    check "serial: second run ran only after the first finished" "a-start a-end b" "$(tr '\n' ' ' < "$log" | sed 's/ $//')"
    same_bytes "serial: second run prints nothing on stdout" /dev/null "${dir}/b-out"
    printf 'test-lock: waiting — held by %s running `bash -c echo a-start >> "$1"; sleep 3; echo a-end >> "$1" _ %s` (pid N) since TIME\ntest-lock: acquired after Ns — running\ntest-lock: released after Ns, exit 0\n' "$PWD" "$log" > "${dir}/b-err.expected"
    normalise < "${dir}/b-err" > "${dir}/b-err.normalised"
    same_bytes "serial: second run's transcript names the holder, then the turn" "${dir}/b-err.expected" "${dir}/b-err.normalised"
}

case_killed_holder_frees_the_lock() {
    local dir="${TMP_ROOT}/killed" a_pid
    mkdir -p "$dir"
    write_worker "${dir}/worker.sh" "${dir}/started"
    TEST_LOCK_ROOT="$dir" "$TEST_LOCK" -- "${dir}/worker.sh" 2>/dev/null &
    a_pid=$!
    track "$a_pid"
    wait_for "killed: holder's command started" 30 test -e "${dir}/started" || return
    kill -KILL "$a_pid"
    wait "$a_pid" 2>/dev/null
    # The worker is still alive, and it must not be holding the lock: it never inherited fd 9.
    (TEST_LOCK_ROOT="$dir" "$TEST_LOCK" -- true 2>/dev/null; echo "$?" > "${dir}/next-rc") &
    wait_for "killed: next run got the lock" 30 test -s "${dir}/next-rc" || return
    check "killed: next run ran its command" "0" "$(cat "${dir}/next-rc")"
}

case_terminating_test_lock_stops_the_command() {
    local dir="${TMP_ROOT}/term" a_pid rc
    mkdir -p "$dir"
    write_worker "${dir}/worker.sh" "${dir}/started"
    TEST_LOCK_ROOT="$dir" "$TEST_LOCK" -- "${dir}/worker.sh" >"${dir}/out" 2>"${dir}/err" &
    a_pid=$!
    track "$a_pid"
    wait_for "term: command started" 30 test -e "${dir}/started" || return
    kill -TERM "$a_pid"
    wait "$a_pid"
    rc=$?
    wait_for "term: command is gone" 30 no_process_matching "${dir}/worker.sh"
    check "term: exits with the command's exit code" "143" "$rc"
    same_bytes "term: prints nothing on stdout" /dev/null "${dir}/out"
    printf 'test-lock: lock free — running\ntest-lock: released after Ns, exit 143\n' > "${dir}/err.expected"
    normalise < "${dir}/err" > "${dir}/err.normalised"
    same_bytes "term: stderr is the lock's transcript" "${dir}/err.expected" "${dir}/err.normalised"
}

case_interrupting_test_lock_stops_the_command() {
    local dir="${TMP_ROOT}/int" a_pid rc
    mkdir -p "$dir"
    write_perl_worker "${dir}/worker.sh" "${dir}/started" "${dir}/pid"
    # A background job starts with SIGINT ignored, and test-lock inherits that unless it is restored.
    perl -e '$SIG{INT}=$SIG{QUIT}="DEFAULT"; exec @ARGV' env TEST_LOCK_ROOT="$dir" "$TEST_LOCK" -- "${dir}/worker.sh" 2>/dev/null &
    a_pid=$!
    track "$a_pid"
    wait_for "int: command started" 30 test -e "${dir}/started" || return
    kill -INT "$a_pid"
    wait_for "int: test-lock exited" 30 no_process "$a_pid" || return
    wait "$a_pid"
    rc=$?
    wait_for "int: command is gone" 30 no_process "$(cat "${dir}/pid")"
    check "int: exits 130" "130" "$rc"
}

case_beats_while_waiting_and_running() {
    local dir="${TMP_ROOT}/beats" a_pid
    mkdir -p "$dir"
    write_dashboard_stub "${dir}/dashboard" "${dir}/beats" "${dir}/running"
    TEST_LOCK_ROOT="$dir" "$TEST_LOCK" -- bash -c 'touch "$1"; sleep 4' _ "${dir}/a-started" 2>/dev/null &
    a_pid=$!
    track "$a_pid"
    wait_for "beats: holder started" 30 test -e "${dir}/a-started" || return
    CLAUDE_CODE_SESSION_ID=sess-b TEST_LOCK_BEAT_SECONDS=1 TEST_LOCK_DASHBOARD="${dir}/dashboard" \
        TEST_LOCK_ROOT="$dir" "$TEST_LOCK" -- bash -c 'touch "$1"; sleep 3' _ "${dir}/running" 2>/dev/null
    wait "$a_pid"
    printf 'running session heartbeat --session sess-b\nwaiting session heartbeat --session sess-b\n' > "${dir}/beats.expected"
    sort -u "${dir}/beats" > "${dir}/beats.unique" 2>/dev/null
    same_bytes "beats: beats the session both while waiting and while running" "${dir}/beats.expected" "${dir}/beats.unique"
}

case_beat_flag_names_the_session() {
    local dir="${TMP_ROOT}/beat-flag" before after
    mkdir -p "$dir"
    write_dashboard_stub "${dir}/dashboard" "${dir}/beats" "${dir}/never"
    CLAUDE_CODE_SESSION_ID=own-session TEST_LOCK_BEAT_SECONDS=1 TEST_LOCK_DASHBOARD="${dir}/dashboard" \
        TEST_LOCK_ROOT="$dir" "$TEST_LOCK" --beat lead-session -- sleep 3 2>/dev/null
    printf 'waiting session heartbeat --session lead-session\n' > "${dir}/beats.expected"
    sort -u "${dir}/beats" > "${dir}/beats.unique" 2>/dev/null
    same_bytes "beat flag: beats only the named session" "${dir}/beats.expected" "${dir}/beats.unique"
    before="$(wc -l < "${dir}/beats" 2>/dev/null || echo 0)"
    sleep 3
    after="$(wc -l < "${dir}/beats" 2>/dev/null || echo 0)"
    check "beat flag: beating stops when test-lock exits" "$before" "$after"
}

case_killed_test_lock_stops_beating() {
    local dir="${TMP_ROOT}/beat-kill" a_pid before after
    mkdir -p "$dir"
    write_dashboard_stub "${dir}/dashboard" "${dir}/beats" "${dir}/never"
    write_worker "${dir}/worker.sh" "${dir}/started"
    CLAUDE_CODE_SESSION_ID=sess-k TEST_LOCK_BEAT_SECONDS=1 TEST_LOCK_DASHBOARD="${dir}/dashboard" \
        TEST_LOCK_ROOT="$dir" "$TEST_LOCK" -- "${dir}/worker.sh" 2>/dev/null &
    a_pid=$!
    track "$a_pid"
    wait_for "beat kill: a beat landed" 30 test -s "${dir}/beats" || return
    kill -KILL "$a_pid"
    wait "$a_pid" 2>/dev/null
    sleep 2
    before="$(wc -l < "${dir}/beats")"
    sleep 3
    after="$(wc -l < "${dir}/beats")"
    check "beat kill: no beat lands once test-lock is SIGKILLed" "$before" "$after"
}

case_no_session_no_beat() {
    local dir="${TMP_ROOT}/no-session"
    mkdir -p "$dir"
    write_dashboard_stub "${dir}/dashboard" "${dir}/beats" "${dir}/never"
    TEST_LOCK_BEAT_SECONDS=1 TEST_LOCK_DASHBOARD="${dir}/dashboard" \
        TEST_LOCK_ROOT="$dir" "$TEST_LOCK" -- sleep 3 2>/dev/null
    check "no session: never beats" "absent" "$([[ -e "${dir}/beats" ]] && echo present || echo absent)"
}

case_nested_call_runs_directly() {
    local dir="${TMP_ROOT}/nested" a_pid
    mkdir -p "$dir"
    TEST_LOCK_ROOT="$dir" "$TEST_LOCK" -- bash -c 'touch "$1"; sleep 10' _ "${dir}/a-started" 2>/dev/null &
    a_pid=$!
    track "$a_pid"
    wait_for "nested: holder started" 30 test -e "${dir}/a-started" || return
    (TEST_LOCK_HELD=1 TEST_LOCK_ROOT="$dir" "$TEST_LOCK" -- echo ran > "${dir}/out" 2> "${dir}/err"; echo "$?" > "${dir}/rc") &
    wait_for "nested: ran without waiting on the held lock" 5 test -s "${dir}/rc"
    check "nested: exits 0" "0" "$(cat "${dir}/rc" 2>/dev/null)"
    printf 'ran\n' > "${dir}/out.expected"
    same_bytes "nested: command output" "${dir}/out.expected" "${dir}/out"
    same_bytes "nested: prints nothing of its own" /dev/null "${dir}/err"
    kill "$a_pid" 2>/dev/null
    wait "$a_pid" 2>/dev/null
}

case_status_names_the_holder() {
    local dir="${TMP_ROOT}/status" a_pid rc
    mkdir -p "$dir"
    TEST_LOCK_ROOT="$dir" "$TEST_LOCK" status > "${dir}/out" 2> "${dir}/err"
    rc=$?
    same_bytes "status: free lock prints nothing on stderr" /dev/null "${dir}/err"
    printf 'free\n' > "${dir}/out.expected"
    same_bytes "status: free lock prints free" "${dir}/out.expected" "${dir}/out"
    check "status: exits 0 when free" "0" "$rc"
    TEST_LOCK_ROOT="$dir" "$TEST_LOCK" -- bash -c 'touch "$1"; sleep 10' _ "${dir}/a-started" 2>/dev/null &
    a_pid=$!
    track "$a_pid"
    wait_for "status: holder started" 30 test -e "${dir}/a-started" || return
    TEST_LOCK_ROOT="$dir" "$TEST_LOCK" status > "${dir}/held-out" 2> "${dir}/held-err"
    rc=$?
    same_bytes "status: held lock prints nothing on stderr" /dev/null "${dir}/held-err"
    printf 'held by %s running `bash -c touch "$1"; sleep 10 _ %s` (pid N) since TIME\n' "$PWD" "${dir}/a-started" > "${dir}/held-out.expected"
    normalise < "${dir}/held-out" > "${dir}/held-out.normalised"
    same_bytes "status: held lock names the holder" "${dir}/held-out.expected" "${dir}/held-out.normalised"
    check "status: exits 0 when held" "0" "$rc"
    kill "$a_pid" 2>/dev/null
    wait "$a_pid" 2>/dev/null
}

case_stdin_reaches_the_command() {
    local dir="${TMP_ROOT}/stdin"
    mkdir -p "$dir"
    printf 'hi\n' | TEST_LOCK_ROOT="$dir" "$TEST_LOCK" -- cat >"${dir}/out" 2>"${dir}/err"
    check "stdin: exits 0" "0" "${PIPESTATUS[1]}"
    printf 'hi\n' > "${dir}/out.expected"
    same_bytes "stdin: the command reads test-lock's stdin" "${dir}/out.expected" "${dir}/out"
    printf 'test-lock: lock free — running\ntest-lock: released after Ns, exit 0\n' > "${dir}/err.expected"
    normalise < "${dir}/err" > "${dir}/err.normalised"
    same_bytes "stdin: stderr is the lock's transcript" "${dir}/err.expected" "${dir}/err.normalised"
}

case_unrunnable_command_exits_like_a_shell() {
    local dir="${TMP_ROOT}/unrunnable" rc
    mkdir -p "$dir"
    TEST_LOCK_ROOT="$dir" "$TEST_LOCK" -- no-such-command-xyz >"${dir}/out" 2>"${dir}/err"
    rc=$?
    check "unrunnable: a missing command exits 127" "127" "$rc"
    printf 'test-lock: lock free — running\ntest-lock: cannot run no-such-command-xyz: No such file or directory\ntest-lock: released after Ns, exit 127\n' > "${dir}/err.expected"
    normalise < "${dir}/err" > "${dir}/err.normalised"
    same_bytes "unrunnable: stderr says which command could not run" "${dir}/err.expected" "${dir}/err.normalised"
    same_bytes "unrunnable: a missing command prints nothing on stdout" /dev/null "${dir}/out"
    printf 'not a program\n' > "${dir}/plain"
    TEST_LOCK_ROOT="$dir" "$TEST_LOCK" -- "${dir}/plain" >"${dir}/plain-out" 2>"${dir}/plain-err"
    check "unrunnable: a command that is not executable exits 126" "126" "$?"
    same_bytes "unrunnable: a non-executable command prints nothing on stdout" /dev/null "${dir}/plain-out"
    printf 'test-lock: lock free — running\ntest-lock: cannot run %s: Permission denied\ntest-lock: released after Ns, exit 126\n' "${dir}/plain" > "${dir}/plain-err.expected"
    normalise < "${dir}/plain-err" > "${dir}/plain-err.normalised"
    same_bytes "unrunnable: stderr says the command is not executable" "${dir}/plain-err.expected" "${dir}/plain-err.normalised"
}

case_unopenable_lock_runs_unlocked() {
    local dir="${TMP_ROOT}/no-such-root" rc
    TEST_LOCK_ROOT="$dir" "$TEST_LOCK" -- bash -c 'exit 4' >"${TMP_ROOT}/unopenable-out" 2>"${TMP_ROOT}/unopenable-err"
    rc=$?
    check "unopenable: exits with the command's exit code" "4" "$rc"
    same_bytes "unopenable: prints nothing on stdout" /dev/null "${TMP_ROOT}/unopenable-out"
    printf 'test-lock: cannot open %s/%s/lock — running unlocked\n' "$dir" "$LOCK_DIR_NAME" > "${TMP_ROOT}/unopenable-err.expected"
    same_bytes "unopenable: warns it is running unlocked" "${TMP_ROOT}/unopenable-err.expected" "${TMP_ROOT}/unopenable-err"
}

case_symlinked_lock_dir_runs_unlocked() {
    local dir="${TMP_ROOT}/symlink" rc
    mkdir -p "${dir}/real"
    ln -s "${dir}/real" "${dir}/${LOCK_DIR_NAME}"
    TEST_LOCK_ROOT="$dir" "$TEST_LOCK" -- bash -c 'exit 5' >"${dir}/out" 2>"${dir}/err"
    rc=$?
    check "symlink: exits with the command's exit code" "5" "$rc"
    same_bytes "symlink: prints nothing on stdout" /dev/null "${dir}/out"
    printf 'test-lock: cannot open %s/%s/lock — running unlocked\n' "$dir" "$LOCK_DIR_NAME" > "${dir}/err.expected"
    same_bytes "symlink: warns it is running unlocked" "${dir}/err.expected" "${dir}/err"
    check "symlink: wrote nothing through the link" "" "$(ls "${dir}/real")"
}

# A flock on PATH that finds the lock held and then fails to wait, so the run falls back to unlocked
# while another run's holder record is in place. find_locker prefers flock, so this stands in for
# the locker on either platform.
case_failed_wait_keeps_the_holder_record() {
    local dir="${TMP_ROOT}/failed-wait" rc
    mkdir -p "${dir}/bin" "${dir}/${LOCK_DIR_NAME}"
    chmod 700 "${dir}/${LOCK_DIR_NAME}"
    printf '#!/bin/sh\nexit 1\n' > "${dir}/bin/flock"
    chmod +x "${dir}/bin/flock"
    printf 'other holder\n' > "${dir}/${LOCK_DIR_NAME}/holder"
    PATH="${dir}/bin:${PATH}" TEST_LOCK_ROOT="$dir" "$TEST_LOCK" -- bash -c 'exit 6' >"${dir}/out" 2>"${dir}/err"
    rc=$?
    check "failed wait: exits with the command's exit code" "6" "$rc"
    same_bytes "failed wait: prints nothing on stdout" /dev/null "${dir}/out"
    printf 'test-lock: waiting — held by other holder\ntest-lock: could not take the lock — running unlocked\ntest-lock: released after Ns, exit 6\n' > "${dir}/err.expected"
    normalise < "${dir}/err" > "${dir}/err.normalised"
    same_bytes "failed wait: warns it is running unlocked" "${dir}/err.expected" "${dir}/err.normalised"
    check "failed wait: the holder record still names the original holder" "other holder" "$(cat "${dir}/${LOCK_DIR_NAME}/holder")"
}

case_usage_errors() {
    "$TEST_LOCK" >/dev/null 2>&1
    check "usage: no arguments exits 2" "2" "$?"
    "$TEST_LOCK" -- >/dev/null 2>&1
    check "usage: no command exits 2" "2" "$?"
    "$TEST_LOCK" --beat >/dev/null 2>&1
    check "usage: --beat with no session exits 2" "2" "$?"
    "$TEST_LOCK" pnpm test >/dev/null 2>&1
    check "usage: a command without -- exits 2" "2" "$?"
}

# A command that marks when it has started, then outlives any case that does not stop it. Its output
# goes nowhere, so a sleep it leaves behind cannot hold this suite's stdout open, and it records its
# own pid and its sleep's so cleanup can kill exactly those, by number.
write_worker() {
    printf '#!/usr/bin/env bash\nexec >/dev/null 2>&1\ntouch "%s"\nsleep 60 &\necho "$$ $!" >> "%s"\nwait\n' \
        "$2" "${TMP_ROOT}/pids" > "$1"
    chmod +x "$1"
}

# A command that is killed by SIGINT on any bash, since it is a perl loop with default dispositions.
# It becomes the perl process by exec, so the pid it records is the loop's own.
write_perl_worker() {
    printf '#!/usr/bin/env bash\necho "$$" > "%s"\necho "$$" >> "%s"\ntouch "%s"\nexec perl -e '"'"'sleep 1 while 1'"'"'\n' \
        "$3" "${TMP_ROOT}/pids" "$2" > "$1"
    chmod +x "$1"
}

# A stand-in for bin/dashboard that records each call and whether the command had started yet.
write_dashboard_stub() {
    cat > "$1" <<STUB
#!/usr/bin/env bash
if [[ -e "$3" ]]; then state=running; else state=waiting; fi
echo "\${state} \$*" >> "$2"
STUB
    chmod +x "$1"
}

# Records a pid the suite backgrounded, so cleanup kills it even when its case fails.
track() {
    echo "$1" >> "${TMP_ROOT}/pids"
}

no_process() {
    ! kill -0 "$1" 2>/dev/null
}

no_process_matching() {
    ! pgrep -f "$1" >/dev/null
}

# Durations, pids and times vary run to run; everything else in a transcript is compared as it is.
normalise() {
    sed -E 's/(after) [0-9]+s/\1 Ns/; s/\(pid [0-9]+\)/(pid N)/; s/since [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8}/since TIME/'
}

wait_for() {
    local label="$1" deadline=$(($(date +%s) + $2))
    shift 2
    until "$@"; do
        if (($(date +%s) >= deadline)); then
            echo "FAIL: timed out waiting for: ${label}"
            FAIL=$((FAIL + 1))
            return 1
        fi
        sleep 0.1
    done
}

check() {
    if [[ "$2" == "$3" ]]; then
        echo "PASS: $1"
        PASS=$((PASS + 1))
    else
        echo "FAIL: $1"
        echo "  expected: $2"
        echo "  actual:   $3"
        FAIL=$((FAIL + 1))
    fi
}

same_bytes() {
    if cmp -s "$2" "$3"; then
        echo "PASS: $1"
        PASS=$((PASS + 1))
    else
        echo "FAIL: $1"
        echo "  expected bytes:"
        od -c "$2" | sed 's/^/    /'
        echo "  actual bytes:"
        od -c "$3" | sed 's/^/    /'
        FAIL=$((FAIL + 1))
    fi
}

cleanup() {
    [[ -f "${TMP_ROOT}/pids" ]] && xargs kill < "${TMP_ROOT}/pids" 2>/dev/null
    rm -rf "$TMP_ROOT"
}

main "$@"
