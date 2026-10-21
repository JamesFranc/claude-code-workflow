#!/bin/bash
# Pre-tool hook: blocks bash the harness would stop to ask about, and pattern kills.
#
# The harness's own danger check asks the user, even in bypass mode, whenever it cannot tell what a
# command will do. This hook blocks those shapes first, each with a message naming the alternative:
#   - pattern kills (pkill / killall), which over-match other sessions' processes and destroy the
#     evidence needed to find the real problem; a targeted `kill <pid>` stays allowed;
#   - a heredoc fed to an interpreter, and a heredoc written to a file (cat or tee);
#   - a deletion whose target is only known when it runs: an rm or rmdir operand holding a
#     variable, a glob or a substitution, a critical path (/ ~ . ..), or an rm run through
#     $(...), bash -c, xargs or find.
# A literal-path delete, `cat >&2 <<EOF`, `--body-file -` and the
# `git commit -m "$(cat <<'EOF' ... EOF)"` idiom stay allowed.

set -euo pipefail

# Read hook input from stdin
INPUT=$(cat)

# Extract the bash command. Guarded (FLOW-183): under `set -e`, an unguarded assignment from a
# failing/missing jq would abort the script before its intentional fail-open path below.
if command -v jq >/dev/null 2>&1; then
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || COMMAND=""
else
  COMMAND=""
fi

if [[ -z "$COMMAND" ]]; then
  exit 0  # No command, allow
fi

# Segment-scoped match (FLOW-228): tokenize with the same shlex-based segment analyzer five other
# hooks already share (FLOW-225; see dashboard-enter-guard.sh for the canonical copy and the
# duplication rationale -- six hooks total after this port) and block when pkill or killall
# appears as a bare token ANYWHERE in a segment, not only at command position. Command-position
# matching needs a wrapper-word enumeration (sudo, xargs, timeout, ...), and that enumeration is
# what produced five fail-opens here: `>/dev/null pkill`, `2>/dev/null pkill`, `if pkill`,
# `while pkill`, and `! pkill` all reach a command position no fixed wrapper list enumerates.
# Anywhere-in-segment fails toward BLOCKING; command-position fails toward ALLOWING — for a guard,
# the fail-open is worse (FLOW-225's governing trade, applied unchanged here).
#
# Accepted price: an unquoted mention (`echo pkill node`) is now blocked, same as a real
# invocation. A quoted one (`echo "run pkill later"`) is not, because shlex keeps quoted text as a
# single token.

# Known limitation: a killer nested inside a QUOTED interpreter argument (e.g. `bash -c 'pkill
# foo'`, `sh -c '...'`, `python3 -c '...'`, or a quoted `eval "pkill foo"`) is NOT caught — shlex
# keeps that quoted string as a single token, so the tokenizer never sees `pkill` as its own word
# inside it. An UNQUOTED mention next to an interpreter word (`eval pkill foo`, `exec pkill foo`,
# or any other unquoted bare mention anywhere in the segment) IS caught, same as any bare token —
# this is no longer limited to `eval`/`exec` specifically.
#
# An interpreter-fed HEREDOC body (`bash <<EOF` / `pkill foo` / `EOF`) is caught in two ways, and
# what "caught" actually guarantees is stated precisely here because an earlier version of this
# comment overstated it and FLOW-225's own sweep once cleared this hook by trusting a comment that
# no longer matched the code — that mistake is the reason this ticket exists, and this hook does
# not get to repeat it.
#
# 1. NAMED interpreter: the consumer is a literal word in the fixed INTERPRETERS enumeration
#    (bash, sh, zsh, ksh, dash, eval, perl, ruby, xargs, python*). The shared analyzer treats a
#    heredoc body as inert data only when its consumer is a known data sink (`cat`) with no
#    interpreter named on the opener line, and recognizes an interpreter name
#    even when a backslash or adjacent quoting splits it into pieces (`b\ash`, `"b"ash`).
# 2. OPAQUE interpreter: the consumer or a pipeline target is an expansion this analyzer cannot
#    resolve by name at all — `$SHELL`, `${CMD}`, a bare `$X`, a `$(...)` or backtick substitution.
#    INTERPRETERS is a fixed enumeration and no
#    enumeration can be completed against a value only known at runtime, so this is a DIFFERENT
#    decision, not an extension of the list: any opaque expansion found specifically in CONSUMER
#    POSITION (the first real word of the opener line, or the first word of each pipeline stage
#    after it — not every `$`-prefixed word anywhere on the line) is treated as POSSIBLY an
#    interpreter and declines to strip. Confirmed against real bash this does NOT false-block a
#    `cat` heredoc whose expansion sits in a redirect target or path instead of consumer position
#    (`cat <<EOF > "$FILE"`, `>> $LOG`, `> ${DIR}/f`, `> out-$(date +%s).txt`, `> /tmp/$USER.txt`,
#    or a leading `VAR=value` assignment before the real consumer, `EDITOR=$CMD cat <<EOF > f`) —
#    an earlier, unproven version of this fix keyed on "any unresolvable expansion anywhere on the
#    line" and would have false-blocked all six of those.
#
# What this does NOT cover: an opaque expansion that is not itself in consumer position — a second
# or later word of a pipeline stage (`cat <<EOF | prefix $CMD`, where `prefix` is checked and
# `$CMD` is not) is not detected by this mechanism. Scoped this way deliberately, matching the
# measured corpus rather than chasing every conceivable shape; not claimed to be exhaustive.
# Nested interpreters reached through a QUOTED argument (the paragraph above) still need a
# different mechanism entirely.

if command -v python3 >/dev/null 2>&1; then
  RESULT=$(python3 - "$COMMAND" 2>/dev/null <<'PY'
import bisect, re, shlex, sys

# FLOW-225 design decision: this segment tokenizer is duplicated, not extracted into a shared
# module, across six hooks -- see dashboard-enter-guard.sh (the canonical copy) for the full
# reasoning.

def raw_substitution_spans(command):
    # Defined in all six hooks for the shared-analyzer byte-identical convention, but only
    # called by the three unconditional hooks (dangerous-command-guard.sh, no-verify-guard.sh,
    # pr-merge-guard.sh) -- dead code in the other three, on purpose; look for the call site in
    # THIS hook's own tail before assuming it's used here.
    #
    # shlex has no notion of command substitution, and by
    # the time a token reaches strip_shell_meta()/normalize_bin(), shlex has ALREADY erased whether
    # it came from a single- or double-quoted span -- both de-quote to the same plain text. A
    # per-token check built on that text cannot tell 'docs: `pkill` is banned' (single-quoted,
    # backtick is LITERAL, bash never runs it) apart from the same text double-quoted (backtick IS
    # a real command substitution, bash executes it) -- confirmed against real bash for both, plus
    # an unquoted form, an escaped backtick outside any quote (also literal), and an apostrophe
    # inside the double-quoted span before the backtick (still a real substitution). An earlier
    # attempt checked spans per shlex TOKEN and had exactly this blind spot -- caught immediately
    # by its own new test suite regressing the single-quoted control from ALLOW to BLOCK, before
    # ever reaching a hook file.
    #
    # This function instead scans the RAW command text directly, the same way strip_comments() and
    # is_outside_quotes() do, tracking single- and double-quote state (and $(...) nesting) with the
    # same backslash-escape-parity rule used everywhere else on this ticket, and extracts a
    # backtick or $(...) span's inner text ONLY when it is found outside a real single quote --
    # single quotes suppress command substitution entirely in real bash, the one quote state that
    # matters for this specific decision. Callers check each returned span with the same bare-
    # word/flag regex their own PARSE_FAILED fallback already uses; a nested substitution's content
    # is still caught by that regex without recursing, since the outer span's extracted text simply
    # contains the inner one.
    #
    # ACCEPTED OVER-BLOCK, measured and stated rather than left implicit:
    # this text-level bare-word check cannot tell a substitution that EXECUTES the guarded word
    # apart from one that merely MENTIONS it in data the substitution reads or searches --
    # confirmed against real bash for a filename containing it ('cat /tmp/pkill-notes.txt'), a
    # grep pattern for it ('grep pkill /var/log/x.log'), and a git log search for it
    # ('git log --grep=pkill'), all with bash NEVER running the guarded command, all now BLOCKED
    # anyway. Deliberate, not an oversight: this is the same trade the PARSE_FAILED fallback
    # already makes everywhere else in this file (bare-word text matching, fails toward
    # blocking), reused here rather than invented fresh.
    #
    # CONSIDERED AND REJECTED: running the segment analyzer recursively on each span's text, so
    # only a genuine COMMAND-POSITION token match would block (the cat-filename and git---grep=
    # cases above would clear, since the word there is embedded in a longer token, not a
    # standalone one). Rejected for two reasons, not merely left undone: first, it would not
    # even close the gap -- the grep-argument case above ('grep pkill ...') has the guarded word
    # as its OWN token, which the anywhere-in-segment matching this file already uses elsewhere
    # (Shape 4, no-verify-guard.sh) would still catch, so the reduction in false positives is
    # partial, not complete. Second, and more decisive on this ticket specifically: it would mean
    # recursively invoking strip_heredocs()/strip_comments()/shlex-tokenize/segment-split inside
    # a span, then re-threading each of the three callers' own DIFFERENT guarded-pattern logic
    # (bare killer word, git+flag, gh+pr+merge+admin) through that recursive result -- new surface
    # area for exactly the class of defect this ticket has hit five times already. The over-block
    # is inconvenient, not dangerous; the recursive alternative's own risk was judged larger than
    # the imprecision it would only partially fix.
    spans = []
    squote = False
    dquote = False
    bs_run = 0
    i = 0
    n = len(command)
    while i < n:
        c = command[i]
        outside = not squote
        if outside and c == '\\':
            bs_run += 1
            i += 1
            continue
        escaped = outside and (bs_run % 2 == 1)
        bs_run = 0
        if escaped:
            i += 1
            continue
        if squote:
            if c == "'":
                squote = False
            i += 1
            continue
        if c == "'" and not dquote:
            squote = True
            i += 1
            continue
        if c == '"':
            dquote = not dquote
            i += 1
            continue
        if c == '$' and i + 1 < n and command[i + 1] == '(':
            depth = 1
            j = i + 2
            start = j
            while j < n and depth > 0:
                if command[j] == '(':
                    depth += 1
                elif command[j] == ')':
                    depth -= 1
                j += 1
            spans.append(command[start:j - 1] if depth == 0 else command[start:])
            i = j
            continue
        if c == '`':
            j = i + 1
            while j < n and command[j] != '`':
                if command[j] == '\\' and j + 1 < n:
                    j += 2
                    continue
                j += 1
            spans.append(command[i + 1:j])
            i = j + 1 if j < n else n
            continue
        i += 1
    return spans

def strip_shell_meta(tok):
    # A subshell/negation/substitution operator ('(', '$(', backtick, '!') is not in
    # punctuation_chars, so it fuses onto an adjacent word instead of becoming its own token:
    # '(pkill', '$(pkill' never equal 'pkill'. Strip both ends before comparing.
    while True:
        if tok.startswith('$('):
            tok = tok[2:]
        elif tok[:1] in ('(', '`', '!'):
            tok = tok[1:]
        else:
            break
    while tok[-1:] in (')', '`'):
        tok = tok[:-1]
    return tok

def normalize_bin(tok):
    # Basename so a path to the binary ('/usr/bin/pkill') still matches.
    return strip_shell_meta(tok).rsplit('/', 1)[-1]

INTERPRETERS = {'bash', 'sh', 'zsh', 'ksh', 'dash', 'eval', 'perl', 'ruby', 'xargs'}

def is_interpreter(tok):
    name = normalize_bin(tok)
    return name in INTERPRETERS or name.startswith('python')

def line_fragments(line):
    # A FIFTH escape-blind
    # site, independent of the four already closed. This function used to split the raw line on
    # anything outside [A-Za-z0-9_./], quote- and escape-blind by construction -- an interpreter
    # name broken by a backslash ('b\ash') or a quote ('"b"ash') disintegrated into fragments that
    # match nothing in INTERPRETERS, so line_has_interpreter() read the opener line as consumer-
    # free and strip_heredocs() deleted the body as inert data -- while bash pipes that same body
    # to a real shell that runs it. Confirmed against real bash for both the backslash-split and
    # quote-split shapes.
    #
    # Ported, not re-derived: the same backslash-escape-parity rule as strip_comments() and
    # is_outside_quotes() (see either for the mechanism), carrying the FULL $(...) stack from
    # is_outside_quotes() too -- not just the squote/dquote flags -- because this function's own
    # "quote-naive on purpose" trade-off (below) depends on it. A first attempt using only
    # squote/dquote flags broke that trade-off: an opener line whose closing quote genuinely lives
    # several lines later would let the FIRST quote character swallow the rest of the line into one
    # fragment, hiding a data-sink name like 'cat' inside "$(cat <<'EOF'" the same way the escaped
    # forms hide an interpreter -- caught by testing that exact case from the paragraph below before
    # trusting this fix, not by inspection. The stack fixes it: a '$(' pushes a FRESH, unquoted
    # context (real shell semantics -- quoting does not cross a $() boundary), so a data-sink or
    # interpreter name inside one is still recognized as its own fragment even while the line's own
    # outer quote never closes on this line.
    #
    # Quote-naive REMAINS the right call for a quote that is still open at end of line with no
    # $(...) to reset it: the opener line is very often the FIRST line of a construct whose closing
    # quote lives several lines later (e.g. "$(cat <<'EOF' ... EOF)" ), so shlex.split on just this
    # one line routinely raises on an unterminated quote for perfectly legitimate data heredocs.
    # Trailing content swallowed into one fragment this way matches nothing in INTERPRETERS or
    # DATA_SINKS either, which only ever pushes toward NOT stripping -- the safe direction, same
    # trade this file makes everywhere else.
    fragments = []
    current = []
    stack = [{'squote': False, 'dquote': False}]
    bs_run = 0
    i = 0
    n = len(line)
    while i < n:
        c = line[i]
        top = stack[-1]
        outside = not top['squote'] and not top['dquote']
        if outside and c == '\\':
            bs_run += 1
            i += 1
            continue
        escaped = outside and (bs_run % 2 == 1)
        bs_run = 0
        if escaped:
            current.append(c)
            i += 1
            continue
        if top['squote']:
            if c == "'":
                top['squote'] = False
            else:
                current.append(c)
            i += 1
            continue
        if top['dquote']:
            if c == '\\' and i + 1 < n:
                current.append(line[i + 1])
                i += 2
                continue
            if c == '"':
                top['dquote'] = False
                i += 1
                continue
            if c == '$' and i + 1 < n and line[i + 1] == '(':
                stack.append({'squote': False, 'dquote': False})
                i += 2
                continue
            current.append(c)
            i += 1
            continue
        if c == "'":
            top['squote'] = True
            i += 1
            continue
        if c == '"':
            top['dquote'] = True
            i += 1
            continue
        if c == '$' and i + 1 < n and line[i + 1] == '(':
            stack.append({'squote': False, 'dquote': False})
            i += 2
            continue
        if c == ')' and len(stack) > 1:
            stack.pop()
            i += 1
            continue
        if re.match(r'[A-Za-z0-9_./]', c):
            current.append(c)
            i += 1
            continue
        if current:
            fragments.append(''.join(current))
            current = []
        i += 1
    if current:
        fragments.append(''.join(current))
    return fragments
WRAPPERS = {'env', 'nohup', 'setsid', 'timeout', 'time', 'stdbuf', 'nice', 'sudo', 'doas', 'command', 'exec'}

def consumer_words(line):
    # The word that actually reads a heredoc's body: the first real command word on the opener
    # line (after skipping leading VAR=value assignments), and the first word of each pipeline
    # stage after it -- 'cat <<EOF | bash' redirects the heredoc into cat's stdin, but cat's own
    # stdout is what's piped into bash's stdin next, and bash EXECUTES whatever it reads from
    # stdin by default. Quote-naive on purpose, matching line_fragments()'s own trade-off and for
    # the same reason: the opener line can have a quote that closes several lines later, and a
    # plain whitespace/pipe split still finds the right WORD POSITIONS without needing to resolve
    # that quote.
    #
    # Also skips a run of known WRAPPER commands before
    # taking the consumer word, the same way it already skips VAR=value assignments -- a NAMED
    # interpreter is caught anywhere on the opener line (line_has_interpreter() scans every
    # fragment), but an OPAQUE one was checked only in consumer position, so
    # 'cat <<EOF | env $CMD' walked straight through: 'env' is not itself an interpreter, is not
    # opaque, and consumer_words() stopped there without ever looking at '$CMD'. Same interpreter,
    # same pipeline stage, opposite verdict, decided only by whether the name happened to be
    # spelled out or wrapped. Confirmed against real bash for 'env $CMD' and 'nohup $CMD'.
    #
    # This WRAPPERS set is the same list FLOW-225's old KILLER_AT_COMMAND_POSITION regex carried
    # before this ticket deleted it -- its resurrection here is legitimate where its original use
    # was not. As an EXHAUSTIVE gate on command position (the old design), anything missing from
    # the list became a fail-open. As a SKIP list (this one), anything missing from it just leaves
    # the word in consumer position, still checked by line_has_interpreter()/the opaque check --
    # an incomplete skip list costs precision, not safety, the opposite failure direction.
    #
    # Not covered here: a wrapper that takes its OWN argument before the real consumer
    # ('timeout 5 $SHELL', 'nice -n 10 $SHELL') hides an opaque consumer from this function, since
    # only the bare wrapper NAME is skipped. dangerous-command-guard.sh reads every word of the
    # whole command outside the heredoc bodies instead of resolving a consumer, so it blocks these shapes;
    # the other guards sharing this function do not.
    words = []
    for stage in line.split('|'):
        stage = stage.strip()
        parts = stage.split()
        i = 0
        while i < len(parts):
            if re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', parts[i]):
                i += 1
                continue
            if parts[i] in WRAPPERS:
                i += 1
                continue
            break
        if i < len(parts):
            words.append(parts[i])
    return words

def is_opaque_expansion(word):
    w = word
    if len(w) >= 2 and w[0] in ('"', "'") and w[-1] == w[0]:
        w = w[1:-1]
    return w.startswith('$') or w.startswith('`')

def line_has_interpreter(line):
    # Imprecise word boundaries only make this MORE likely to (safely) decline to strip, never less.
    if any(is_interpreter(f) for f in line_fragments(line)):
        return True
    # INTERPRETERS is a fixed enumeration, and an
    # enumeration cannot be completed against a value only known at runtime -- $SHELL, ${CMD}, a
    # command substitution used as the consumer, or any other opaque expansion in CONSUMER POSITION
    # reads as "not a known interpreter" and its heredoc body was stripped as inert data, even
    # though bash resolves it to a real interpreter and executes the body for real. Confirmed
    # exploitable against real bash for nine opaque forms in consumer/pipeline-target position
    # ($SHELL, ${SHELL}, a quoted "$SHELL", $CMD, $CMD with an argument, $X, ${X}, a $(...)
    # substitution, and a backtick substitution).
    #
    # Fixed by deciding on the DECISION, not the enumeration: this cannot be resolved by name, so
    # any opaque expansion found specifically at a CONSUMER POSITION (this function's own
    # consumer_words(), not every word on the line) is treated as POSSIBLY an interpreter and
    # declines to strip -- failing toward blocking, this file's governing trade throughout.
    # Deliberately scoped to consumer position only, not the whole line: an earlier, unproven
    # version of this fix keyed on "does the line contain any unresolvable expansion at all" and
    # measured against real bash before being adopted -- it would have false-blocked six legitimate
    # forms that carry an expansion in a REDIRECT TARGET or PATH, not the consumer (cat <<EOF >
    # "$FILE"; >> $LOG; > ${DIR}/f; > out-$(date +%s).txt; > /tmp/$USER.txt; and a leading
    # VAR=value assignment before the real consumer, EDITOR=$CMD cat <<EOF > f) -- none of those
    # six has an expansion in consumer position, so none is affected by this narrower version,
    # confirmed unchanged against real bash before adopting it either.
    for word in consumer_words(line):
        if is_opaque_expansion(word):
            return True
    return False

# line_has_interpreter() alone is a BLOCKLIST, so its failure
# axis is membership -- a consumer name absent from the set (an env-var interpreter like $SHELL /
# ${INTERP}, or an interpreter this list never named: node, deno, bun, awk, php, lua, tclsh, ...)
# reads as "not an interpreter" and gets stripped, executing right through the guard. Chasing
# interpreter names is unbounded and can never reach $SHELL. Invert it for the STRIP decision:
# strip only when the consumer is a known DATA-SINK (an allowlist), not merely when no known
# interpreter was spotted. An unrecognized consumer declines to strip and costs a false-block --
# the accepted trade for this ticket, not an oversight; growing this set requires evidence of real
# usage (grepped, not guessed), never speculative padding. Keep line_has_interpreter() too, ANDed
# in: a whitelisted consumer piped into an interpreter later on the same line (cat <<EOF | bash)
# must still decline.
DATA_SINKS = {'cat'}  # the only data-sink command word observed feeding a heredoc in this repo's
                       # tracked, non-test-fixture files -- re-derive with (run from the repo root):
                       #   git grep -hoE "^[[:space:]]*[A-Za-z0-9_./-]+[^<]*<<-?['\"]?[A-Za-z_]" -- ':!hooks/test-*.sh' | awk '{print $1}' | sort -u
                       # (test-*.sh excluded: they contain this fix's own adversarial bash/sh/eval
                       # heredoc fixtures, not real usage. Captures the LINE's first word, not the
                       # word adjacent to '<<' -- an earlier version of this check matched adjacency
                       # and was blind to 'cat >&2 <<EOF', 10 of this repo's 11 production heredocs,
                       # since '2' sits between '>&' and '<<'; that is fixed here, not repeated.)
                       # The python3 heredoc lines in these hooks also match; python3 runs its heredoc as code, so it is never a sink.

def is_data_sink(tok):
    return normalize_bin(tok) in DATA_SINKS

def line_has_data_sink(line):
    return any(is_data_sink(f) for f in line_fragments(line))

def is_outside_quotes(line, pos):
    # Track quote state with a stack so a command substitution $(...) inside a double-quoted
    # string starts a FRESH parsing context (real shell semantics: quoting does not cross into a
    # $() boundary) -- otherwise a legitimate heredoc used to build a quoted "$(cat <<'EOF' ...)"
    # argument would be misread as "inside quotes" and treated as free text.
    #
    # Escape-blindness. This is the SECOND copy of the same
    # state machine as strip_comments() (see strip_comments()'s own Escape-blindness paragraph below for the full story) -- the
    # duplication note below explains why the fix could not simply move with a single edit: a
    # change meant for one must be applied to BOTH by hand, and a previous fix touched only the other
    # copy. An escaped quote outside any quoting ('\'' or '\"') is a literal quote character in
    # real bash, not a real quote-open; treating it as one here desyncs this function's tracked
    # nesting from bash's real one, which strip_heredocs() (the only caller) relies on to decide
    # whether a '<<' opener is genuinely outside quotes. Confirmed exploitable end to end: a
    # heredoc opener that is really INSIDE a quoted string (bash never treats it as an opener at
    # all) was read as a live opener here, so strip_heredocs() deleted the following lines --
    # killer included -- before the tokenizer ever ran. No parse failure, no fallback, nothing
    # reaches the token stream at all. Fixed with the SAME rule as strip_comments(), ported here
    # rather than re-derived: backslash-escape parity is tracked incrementally in the same single
    # pass, and a quote-open character is treated as escaped only when an ODD number of
    # backslashes immediately precedes it.
    stack = [{'squote': False, 'dquote': False}]
    i = 0
    n = len(line)
    bs_run = 0
    while i < pos and i < n:
        c = line[i]
        top = stack[-1]
        outside = not top['squote'] and not top['dquote']
        if outside and c == '\\':
            bs_run += 1
            i += 1
            continue
        escaped = outside and (bs_run % 2 == 1)
        bs_run = 0
        if top['squote']:
            if c == "'":
                top['squote'] = False
            i += 1
            continue
        if top['dquote']:
            if c == '\\' and i + 1 < n:
                i += 2
                continue
            if c == '"':
                top['dquote'] = False
                i += 1
                continue
            if c == '$' and i + 1 < n and line[i + 1] == '(':
                stack.append({'squote': False, 'dquote': False})
                i += 2
                continue
            i += 1
            continue
        if c == "'" and not escaped:
            top['squote'] = True
            i += 1
            continue
        if c == '"' and not escaped:
            top['dquote'] = True
            i += 1
            continue
        # UNPROVEN, kept anyway for consistency with the escape-parity rule applied everywhere
        # else in this function: no concrete exploit was constructed for an escaped '$(' or
        # ')' here (checked against real bash for '\$(ls)', '$(ls\)', a real '$(ls)', and
        # '\$x' -- all measure identically with or without this guard). Not a confirmed row
        # like the quote-open fix above it -- do not extend this pattern further without a
        # concrete reproduction the way the quote-open and comment-boundary ones got.
        if c == '$' and not escaped and i + 1 < n and line[i + 1] == '(':
            stack.append({'squote': False, 'dquote': False})
            i += 2
            continue
        if c == ')' and not escaped and len(stack) > 1:
            stack.pop()
            i += 1
            continue
        i += 1
    top = stack[-1]
    return not top['squote'] and not top['dquote']
HEREDOC_RE = re.compile(r"(?<!<)<<(-?)\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\2")

def strip_heredocs(command):
    # A heredoc BODY is data only when
    # its consumer is a known DATA-SINK and no interpreter appears anywhere on the opener line, and
    # a '<<' is only a real heredoc opener when it occurs OUTSIDE any quoted span. Getting any of
    # these wrong is dangerous in a different direction: treating an interpreter-fed heredoc (or
    # one fed to an unrecognized, unwhitelisted consumer) as data lets its body run right through
    # the guard; treating a quoted '<<' as a real opener can delete real command text between it
    # and an unrelated later line that happens to equal the (fake) delimiter. The governing rule
    # for all three: when unsure, do NOT strip -- leaving text for the tokenizer to see fails
    # toward blocking, the safe direction for a guard; stripping is only the safe choice when every
    # check is affirmatively clear.
    lines = command.split('\n')
    n = len(lines)

    # O(n^2) for a run of unterminated data-sink heredoc
    # openers. Each opener that never finds its delimiter used to scan every remaining line
    # looking for one, the same cost class already fixed in strip_comments -- a per-candidate O(n)
    # scan, repeated once per candidate. Fixed by precomputing a content -> sorted line-index map
    # once (raw, and tab-stripped for the '<<-' dash form) and bisecting into it, so an
    # unterminated opener no longer costs O(n) all by itself.
    raw_index = {}
    dash_index = {}
    for idx, ln in enumerate(lines):
        raw_index.setdefault(ln, []).append(idx)
        dash_index.setdefault(ln.lstrip('\t'), []).append(idx)

    result = []
    i = 0
    while i < n:
        line = lines[i]
        m = None
        for candidate in HEREDOC_RE.finditer(line):
            if not is_outside_quotes(line, candidate.start()):
                continue
            # An escaped
            # '<' right before '<<' ('\<<EOF') is a literal character in real bash, not a heredoc
            # opener at all -- confirmed against real bash for backslash counts 0-4 -- so the
            # following lines are never absorbed as a body; they run as ordinary, separate
            # commands. is_outside_quotes() answers a different question (is this position inside
            # a QUOTE) and says "outside" correctly here, since there is no quoting in play at
            # all; escaping the operator itself is a separate axis this loop was not checking.
            # Same parity rule as every other site on this ticket, applied to the characters
            # immediately preceding the match instead of a quote/trigger character: an ODD run of
            # backslashes right before the match means it is escaped. Bounded, not a rescan risk:
            # the backslash run counted here is local to and never overlaps a NEXT candidate's own
            # run within the same line, so the total cost across every candidate in one line is at
            # most that line's own length, not the whole remaining command.
            bs_count = 0
            j = candidate.start() - 1
            while j >= 0 and line[j] == '\\':
                bs_count += 1
                j -= 1
            if bs_count % 2 == 1:
                continue
            m = candidate
            break
        if m is not None and line_has_data_sink(line) and not line_has_interpreter(line):
            dash = m.group(1) == '-'
            delim = m.group(3)
            index = dash_index if dash else raw_index
            candidates = index.get(delim, [])
            pos = bisect.bisect_right(candidates, i)
            if pos < len(candidates):
                close_idx = candidates[pos]
                result.append(line)
                i = close_idx + 1
                continue
        result.append(line)
        i += 1
    return '\n'.join(result)
def strip_comments(command):
    # Quote state must be evaluated across the
    # WHOLE command, not per line -- is_outside_quotes() builds a fresh stack every call, so a
    # quote opened on an earlier physical line was invisible when checking a '#' on a later one,
    # and a '#' inside a multi-line quoted string read as a real comment starter, discarding a
    # genuine command that followed once the string closed.
    #
    # Quote state must be evaluated over the
    # ACCUMULATED OUTPUT kept so far, not the original command -- a quote character INSIDE a
    # comment that gets stripped must not poison the quote state at a later '#', since bash never
    # lets a stripped comment affect quoting ('# don't' followed on a later line by '# it's': the
    # apostrophe in the first comment is gone once it is stripped, so it cannot leave the second
    # comment looking quoted). Checking against the ORIGINAL command let exactly that happen,
    # producing an unbalanced-quote ValueError that fell open on a real invocation. Per-line
    # evaluation got this particular shape right by accident; whole-command evaluation
    # against the wrong string did not. is_outside_quotes() itself needed no change --
    # it already treats '\n' as an ordinary character. '\n' is also a word-start character here,
    # alongside space and tab. (The trigger set grew further after this: ';', '|', and
    # '&' were added as word-start characters too -- see the Escape-blindness paragraph below for
    # the full current set and the escape-awareness it needed.) The start of a new physical line is a word boundary.
    #
    # O(n^2). The previous implementation called
    # is_outside_quotes() once per '#', and that function RE-DERIVES the entire quote stack from
    # scratch on every call (a fresh O(i) scan), for O(n) '#' characters in the worst case (one
    # per line). A large file written through a heredoc reproduces this: 8000 comment lines took
    # 22.35s, long enough to trip a harness timeout on a routine command. Fixed by tracking the
    # SAME quote-state stack incrementally, one character at a time, in a single pass -- state is
    # already correct by the time a '#' is reached, no re-derivation, O(n) overall.
    #
    # This duplicates is_outside_quotes()'s state machine rather than calling it, because the two
    # need to stay independent: is_outside_quotes() is used by strip_heredocs elsewhere in this
    # file, and sharing the state machine here would let a change meant for one silently move the
    # other. THE COST OF THAT INDEPENDENCE: a fix to one copy does not reach the
    # other automatically, and an escape-parity fix (below) was applied ONLY here, leaving
    # is_outside_quotes() with the identical defect, live and exploitable, until it was caught
    # (see is_outside_quotes()'s own Escape-blindness paragraph above for the mechanism and payload). BOTH copies carry the escape-parity
    # rule -- a future change to that rule belongs in both functions by hand; there
    # is no shared helper to edit once. A stripped (discarded) comment's characters never advance this
    # stack, which preserves the invariant that a comment's own quote characters must not
    # affect quote state at a later position -- by construction: the stack simply never advances
    # past a character that was never kept.
    #
    # Escape-blindness. The trigger-set fix (adding ';', '|', '&' to the comment-boundary trigger
    # set) and the PRE-EXISTING
    # quote-open checks below both inspected a raw neighbouring character with no notion of
    # backslash-escaping -- an ESCAPED trigger character ('\;', '\|', '\&', '\ ') is a literal
    # character in real bash, not an operator, so the '#' right after it starts no comment at all;
    # an ESCAPED quote ('\'' or '\"') outside any quoting is a literal quote character in real
    # bash, not a real quote-open. Both were treated as the real thing. The quote-open miss is the
    # more serious of the two: it can desync our tracked quote nesting from bash's real one by
    # exactly one transition (an escaped quote closes OUR fictitious context one quote early),
    # after which a '#' we see as "outside" is genuinely inside a real bash string to bash itself
    # -- confirmed exploitable end to end: a real invocation placed after that point was silently
    # erased from the token stream with no parse failure to trip the safety-net fallback.
    #
    # Fixed by tracking backslash-escape parity incrementally in the same single pass (no backward
    # rescanning, which would reintroduce the O(n^2) cost documented above): a run of consecutive
    # backslashes outside any quote is counted as it is scanned, and a trigger character or a
    # quote-open character is treated as escaped only when an ODD number of backslashes
    # immediately precedes it -- an escaped backslash pairs off (even count) and leaves the
    # following character genuinely unescaped, matching real bash's own escaping rule.
    #
    # NOT fixed here, by deliberate choice: '(' and ')' are NOT in the trigger set above, even
    # though bash treats a '#' right after either as a real comment start too (confirmed against
    # real bash: both '(ls)#c<newline><killer>' and 'echo $(ls)#c; <killer>' block correctly
    # here, matching bash, with no change needed). The reason is that ')' is ambiguous in a way
    # ';', '|', and '&' are not: a ')' can close a real group/subshell (a boundary, like the
    # operators above) OR end a '$(...)' command substitution fused into the MIDDLE of a
    # surrounding word (not a boundary at all) -- and this character-level scan, unlike the
    # tokenizer below, cannot tell those two apart. Adding ')' as an unconditional trigger would
    # risk treating the command-substitution case as a comment start when it is not one --
    # stripping real command text bash would actually run, the dangerous over-strip direction
    # this file spends the rest of its comments avoiding. Leaving it out costs nothing observed
    # so far: bash already runs a '#' right after ')' as a comment in the boundary case, and
    # this scan's failure to strip it there only leaves extra text for the tokenizer to see,
    # which fails toward BLOCKING -- the safe direction, not a live gap.
    stack = [{'squote': False, 'dquote': False}]
    n = len(command)
    result = []
    bs_run = 0
    prev_escaped = False
    i = 0
    while i < n:
        c = command[i]
        top = stack[-1]
        outside = not top['squote'] and not top['dquote']
        if outside and c == '\\':
            bs_run += 1
            result.append(c)
            i += 1
            continue
        escaped = outside and (bs_run % 2 == 1)
        bs_run = 0
        if c == '#' and outside and (len(result) == 0 or (result[-1] in (' ', '\t', '\n', ';', '|', '&') and not prev_escaped)):
            nl = command.find('\n', i)
            if nl == -1:
                break
            i = nl
            continue
        if top['squote']:
            if c == "'":
                top['squote'] = False
            result.append(c)
            i += 1
            continue
        if top['dquote']:
            if c == '\\' and i + 1 < n:
                result.append(c)
                result.append(command[i + 1])
                i += 2
                continue
            if c == '"':
                top['dquote'] = False
                result.append(c)
                i += 1
                continue
            if c == '$' and i + 1 < n and command[i + 1] == '(':
                stack.append({'squote': False, 'dquote': False})
                result.append(c)
                result.append(command[i + 1])
                i += 2
                continue
            result.append(c)
            i += 1
            continue
        if c == "'" and not escaped:
            top['squote'] = True
            result.append(c)
            i += 1
            continue
        if c == '"' and not escaped:
            top['dquote'] = True
            result.append(c)
            i += 1
            continue
        # UNPROVEN, kept anyway for consistency -- see is_outside_quotes()'s matching guard
        # for the checked-but-not-confirmed shapes. Do not extend this pattern further without
        # a concrete reproduction.
        if c == '$' and not escaped and i + 1 < n and command[i + 1] == '(':
            stack.append({'squote': False, 'dquote': False})
            result.append(c)
            result.append(command[i + 1])
            i += 2
            continue
        if c == ')' and not escaped and len(stack) > 1:
            stack.pop()
            result.append(c)
            i += 1
            continue
        result.append(c)
        prev_escaped = escaped
        i += 1
    return ''.join(result)
PARSE_FAILED = False
try:
    lex = shlex.shlex(strip_comments(strip_heredocs(sys.argv[1])), posix=True, punctuation_chars='&|;\n')
    lex.whitespace_split = True
    lex.whitespace = lex.whitespace.replace('\n', '')
    lex.commenters = ''
    tokens = list(lex)
except ValueError:
    # A bash -n gate here (an earlier attempt at this same gate)
    # allowed too much. Its premise -- "if bash cannot parse the WHOLE command, nothing in it can
    # execute" -- is false: bash is a STREAMING parser, so it executes each complete command as it
    # reads the input, and a syntax error further down does not undo what already ran. A killer on
    # line 1 followed by an unrelated syntax error on line 2 genuinely executes the killer, yet
    # `bash -n` reports the whole script as unparseable, and the gate allowed it -- confirmed
    # against real bash before removing the gate (a marker on line 1 prints, THEN bash reports the
    # later error). The `bash -n` subprocess call, and the soft dependency on a `bash` binary on
    # PATH that came with it, are removed entirely.
    #
    # The trade this makes, stated rather than left implicit: a command shlex cannot tokenize now
    # gets its raw text checked for the guarded signature as a bare word, unconditionally, by each
    # hook's own tail -- no gate distinguishes "genuinely unrunnable" from "partially executes"
    # any more, because that distinction cannot be made reliably from parse-failure alone. This
    # closes the partial-execution class but gives up precisely allowing a command that mentions
    # the guarded word and truly cannot run at all (e.g. a bare unterminated quote with nothing
    # before it) -- that now blocks too. Anywhere-in-text fails toward BLOCKING; the removed gate
    # failed toward ALLOWING in a case that could really execute. For a guard, the former is the
    # safe direction, and blocking a message that merely mentions the word is the accepted price
    # already paid everywhere else in this file for the same trade.
    tokens = []
    PARSE_FAILED = True

OPERATORS = {'&&', '||', ';', '|', '&'}

def is_boundary(tok):
    # A run of '&'/'|'/';' characters merges with an adjacent run of '\n' into one token in
    # punctuation_chars mode (e.g. '&&\n' from '&& ' immediately followed by a line break with no
    # space) — strip the newlines back out before comparing against the known operators.
    core = tok.replace('\n', '')
    return tok != '' and (core == '' or core in OPERATORS)

segments = [[]]
for tok in tokens:
    if is_boundary(tok):
        segments.append([])
    else:
        segments[-1].append(tok)

KILLERS = {'pkill', 'killall'}
DELETERS = {'rm', 'rmdir'}
SHELLS = {'bash', 'sh', 'zsh', 'ksh', 'dash'}
EXTRA_INTERPRETERS = {'node', 'fish', 'csh', 'tcsh', 'awk', 'gawk', 'php', 'lua', 'osascript', 'deno', 'bun', 'source', '.'}
FIND_EXECS = {'-exec', '-execdir', '-ok', '-okdir'}
CRITICAL_PATHS = {'/', '~', '.', '..'}
UNRESOLVABLE_CHARS = '$`*?['
NON_FILE_TARGETS = {'/dev/null', '/dev/stdout', '/dev/stderr'}
COMMAND_POSITION_SKIPS = WRAPPERS | {'if', 'then', 'do', 'else', 'elif', 'while', 'until', '{'}
PUNCTUATION = '&|;\n()<>'
DATA_COMMANDS = {'git', 'gh', 'dashboard'}
BARE_EXPANSION_RE = re.compile(r'\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]*\}|[0-9@*#?$!-])')
CAT_SUBSTITUTION_RE = re.compile(r"\$\(\s*cat\s+<<-?\s*'[A-Za-z_][A-Za-z0-9_]*'\s*\)")
BARE_CAT_RE = re.compile(r"cat\s+(?:>&2\s+)?<<-?\s*'[A-Za-z_][A-Za-z0-9_]*'(?:\s+>&2)?")
ASSIGNMENT_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*=')
REDIRECT_TOKEN_RE = re.compile(r'^[&\d]*(?:>>?|<)&?(.*)$')
RM_WORD_RE = re.compile(r'(?:^|[\s;&|(`])(?<!git )(?:[\w./-]*/)?(?:rm|rmdir)(?=$|[\s;&|)`])')

def main(command):
    # Each class prints its own name, so the bash side can name the alternative that fits it.
    if PARSE_FAILED:
        if re.search(r'\b(pkill|killall)\b', command):
            return 'kill'
    elif runs_killer(command):
        return 'kill'
    return heredoc_class(command) or ('deletion' if deletes_in(command, False) else None)

def runs_killer(command):
    if any(normalize_bin(tok) in KILLERS for seg in segments for tok in seg):
        return True
    return any(re.search(r'\b(pkill|killall)\b', strip_heredocs(span)) for span in raw_substitution_spans(command))

def heredoc_class(command):
    # A command that matches one of data_idiom's idioms is allowed, its quoted body being data.
    # Every other command is read as shell: all of its words outside the heredoc bodies, in every
    # segment, group, function and substitution, are checked, never only the words connected to a
    # heredoc. The $(...) and backtick spans of an unquoted body run, so they are queued and read the
    # same way. A queue, not recursion, keeps the depth of nesting from ever ending the walk early.
    if data_idiom(command):
        return None

    pending = [command]
    while pending:
        visible, unquoted_bodies, openers, _ = split_bodies(pending.pop())
        if openers == 0:
            continue

        found = visible_class(visible)
        if found:
            return found

        for body in unquoted_bodies:
            pending.extend(raw_substitution_spans(body))
    return None

def deletes_in(text, inside_substitution):
    # Inside a $(...) or backtick span bash runs whatever is there, so any rm blocks; at the top
    # level only an rm with an unresolvable target does. Spans are queued, not recursed into.
    pending = [(text, inside_substitution)]
    while pending:
        current, inside = pending.pop()
        current = strip_literal_heredocs(current)
        segs = segments_of(current)
        if segs is None:
            found = RM_WORD_RE.search(strip_comments(strip_heredocs(current))) is not None
        else:
            found = any(deletes_in_segment(seg, inside) for seg in segs)
        if found:
            return True

        pending.extend((span, True) for span in raw_substitution_spans(drop_sink_bodies(current)))
    return False

def drop_sink_bodies(command):
    # The quoted-delimiter bodies strip_heredocs reads as data (a cat opener line naming no
    # interpreter) hold no live $(...) or backtick either.
    lines = command.split('\n')
    kept = []
    i = 0
    while i < len(lines):
        kept.append(lines[i])
        opener = heredoc_opener(lines[i])
        if opener is not None and opener.group(2) and line_has_data_sink(lines[i]) and not line_has_interpreter(lines[i]):
            end = body_end(lines, i, opener)
            i = end + 1 if end > i else i + 1
        else:
            i += 1
    return '\n'.join(kept)

def deletes_in_segment(seg, inside_substitution):
    start = command_start(seg)
    if start is not None and normalize_bin(seg[start]) in DELETERS:
        if inside_substitution or any(is_unresolvable(op) for op in operands(seg[start + 1:])):
            return True
    return deletes_through_another_command(seg)

def tokenize(text):
    lex = shlex.shlex(text, posix=True, punctuation_chars='&|;\n')
    lex.whitespace_split = True
    lex.whitespace = lex.whitespace.replace('\n', '')
    lex.commenters = ''
    return list(lex)

def segments_of(text):
    try:
        tokens = tokenize(strip_comments(strip_heredocs(text)))
    except ValueError:
        return None
    found = [[]]
    for tok in tokens:
        if is_boundary(tok):
            found.append([])
        else:
            found[-1].append(tok)
    return found

def deletes_through_another_command(seg):
    words = [normalize_bin(tok) for tok in seg]
    for i, word in enumerate(words):
        rest = words[i + 1:]
        if word == 'xargs' and DELETERS & set(rest):
            return True
        if word == 'find' and ('-delete' in rest or any(a in FIND_EXECS and b in DELETERS for a, b in zip(rest, rest[1:]))):
            return True
        if word in SHELLS and RM_WORD_RE.search(shell_script(seg[i + 1:])):
            return True
    return False

def command_start(seg):
    # Command position only, unlike the killer check: a deletion this misses is one the harness
    # still asks about, while matching rm anywhere would block every `grep rm` and `echo rm`.
    for i, tok in enumerate(seg):
        word = strip_shell_meta(tok)
        if ASSIGNMENT_RE.match(word) and ('$(' in word or '`' in word):
            return None
        if word and word not in COMMAND_POSITION_SKIPS and not ASSIGNMENT_RE.match(word) and not REDIRECT_TOKEN_RE.match(word):
            return i
    return None

def operands(args):
    found = []
    flags_done = False
    skip_next = False
    for tok in args:
        if skip_next:
            skip_next = False
            continue
        redirect = REDIRECT_TOKEN_RE.match(tok)
        if redirect:
            skip_next = redirect.group(1) == ''
            continue
        if not flags_done and tok == '--':
            flags_done = True
            continue
        if not flags_done and tok.startswith('-') and tok != '-':
            continue
        found.append(tok)
    return found

def is_unresolvable(operand):
    if any(c in operand for c in UNRESOLVABLE_CHARS):
        return True
    return (operand.rstrip(')`').rstrip('/') or '/') in CRITICAL_PATHS

def shell_script(args):
    # The script `bash -c` or `sh -lc` runs: the word after a short-option cluster holding c.
    for i, tok in enumerate(args):
        if not tok.startswith('-'):
            return ''
        if re.match(r'^-[A-Za-z]*c[A-Za-z]*$', tok):
            return args[i + 1] if i + 1 < len(args) else ''
    return ''

def heredoc_opener(line):
    for m in HEREDOC_RE.finditer(line):
        if not is_outside_quotes(line, m.start()):
            continue
        before = line[:m.start()]
        if (len(before) - len(before.rstrip('\\'))) % 2 == 0:
            return m
    return None

def body_end(lines, start, opener):
    for j in range(start + 1, len(lines)):
        line = lines[j].lstrip('\t') if opener.group(1) == '-' else lines[j]
        if line == opener.group(3):
            return j
    return start

def split_bodies(text):
    # The text with every heredoc body and its closing delimiter line cut out, the bodies of the
    # unquoted-delimiter heredocs (whose $(...) and backticks run), the number of heredocs opened,
    # and how many of those have a quoted delimiter. A heredoc with no closing line keeps its text.
    lines = text.split('\n')
    visible = []
    unquoted_bodies = []
    openers = 0
    quoted = 0
    i = 0
    while i < len(lines):
        visible.append(lines[i])
        opener = heredoc_opener(strip_comments(lines[i]))
        if opener is None:
            i += 1
            continue

        openers += 1
        quoted += 1 if opener.group(2) else 0
        end = body_end(lines, i, opener)
        if end > i and not opener.group(2):
            unquoted_bodies.append('\n'.join(lines[i + 1:end]))
        i = end + 1 if end > i else i + 1
    return '\n'.join(visible), unquoted_bodies, openers, quoted

def data_idiom(command):
    # The only commands whose quoted heredoc body is data: one heredoc, one segment, no pipe, group
    # or compound, and either git commit -F -, gh --body-file - / -F -, a "$(cat <<'EOF' ... )"
    # argument of git, gh or dashboard, or a bare cat <<'EOF' with at most a >&2.
    visible, _, openers, quoted = split_bodies(command)
    if openers != 1 or quoted != 1:
        return False

    text = visible.strip()
    if BARE_CAT_RE.fullmatch(text):
        return True

    tokens = lex(text)
    if not tokens or any(kind == 'break' for kind, _ in tokens) or tokens[0][0] != 'word':
        return False

    words = [tok for kind, tok in tokens if kind == 'word']
    pairs = list(zip(words, words[1:]))
    first = normalize_bin(words[0])
    if first == 'git' and 'commit' in words and ('-F', '-') in pairs:
        return True
    if first == 'gh' and (('--body-file', '-') in pairs or ('-F', '-') in pairs):
        return True
    return first in DATA_COMMANDS and any(CAT_SUBSTITUTION_RE.fullmatch(w) for w in words)

def visible_class(text):
    # 'heredoc-file' when a cat or tee stage of the text or of a substitution span in it writes a
    # file, else 'heredoc-interpreter' when any word of them is an interpreter name or a bare
    # parameter expansion, else None. Spans are queued, not recursed into.
    interprets = False
    writes = False
    pending = [text]
    while pending:
        current = pending.pop()
        tokens = lex(current)
        if tokens is None:
            words = re.split(r'[^A-Za-z0-9_$./{}-]+', current)
            interprets = interprets or any(is_interpreter_word(w) or BARE_EXPANSION_RE.fullmatch(w) for w in words)
            writes = writes or re.search(r'\b(?:cat|tee)\b[^|;&\n]*>', current) is not None
            continue

        interprets = interprets or names_interpreter(tokens)
        writes = writes or writes_file(tokens)
        pending.extend(raw_substitution_spans(current))

    if writes:
        return 'heredoc-file'
    return 'heredoc-interpreter' if interprets else None

def lex(text):
    # shlex words with ( ) < > | ; & and newline split out as their own tokens, each tagged 'word',
    # 'redirect' or 'break'; None when the text does not tokenize.
    try:
        lexer = shlex.shlex(text, posix=True, punctuation_chars=PUNCTUATION)
        lexer.whitespace_split = True
        lexer.whitespace = lexer.whitespace.replace('\n', '')
        lexer.commenters = ''
        return [(token_kind(tok), tok) for tok in lexer]
    except ValueError:
        return None

def token_kind(tok):
    if not tok or not all(c in PUNCTUATION for c in tok):
        return 'word'
    if '(' in tok or ')' in tok:
        return 'break'
    return 'redirect' if '<' in tok or '>' in tok else 'break'

def names_interpreter(tokens):
    at_start = True
    skip_target = False
    for kind, tok in tokens:
        if kind == 'break':
            at_start = True
            skip_target = False
        elif kind == 'redirect':
            skip_target = True
        elif skip_target:
            skip_target = False
        else:
            if is_interpreter_word(tok) or BARE_EXPANSION_RE.fullmatch(tok):
                return True
            if at_start and (tok == '$' or tok.startswith('`')):
                return True
            at_start = at_start and ASSIGNMENT_RE.match(tok) is not None
    return False

def is_interpreter_word(tok):
    name = normalize_bin(tok)
    return name in INTERPRETERS or name in EXTRA_INTERPRETERS or re.fullmatch(r'python[\d.]*', name) is not None

def writes_file(tokens):
    for words, redirects in stages_of(tokens):
        names = [normalize_bin(w) for w in words]
        if 'tee' in names and any(not w.startswith('-') for w in words[names.index('tee') + 1:]):
            return True
        if 'cat' in names and redirects:
            return True
    return False

def stages_of(tokens):
    # Each stage as its words and whether it redirects output to a file. A file descriptor number
    # written before a redirect is not a word of the stage.
    stages = []
    words = []
    redirects = False
    operator = None
    for kind, tok in tokens:
        if kind == 'break':
            stages.append((words, redirects))
            words, redirects, operator = [], False, None
        elif kind == 'redirect':
            operator = tok
            if words and words[-1].isdigit():
                words.pop()
        elif operator is not None:
            redirects = redirects or writes_target(operator, tok)
            operator = None
        else:
            words.append(tok)
    stages.append((words, redirects))
    return stages

def writes_target(operator, target):
    if '>' not in operator or target in NON_FILE_TARGETS:
        return False
    return not (operator.endswith('&') and (target.isdigit() or target == '-'))

def strip_literal_heredocs(command):
    # A quoted body is dropped as data only for a data_idiom; any other body stays visible to the
    # deletion rules like any other shell.
    return split_bodies(command)[0] if data_idiom(command) else command

result = main(sys.argv[1])
if result:
    print(result)
PY
) || RESULT=""
else
  RESULT=""
fi

case "$RESULT" in
  kill)
    cat >&2 <<'EOF'
BLOCKED: blind pattern-kill (pkill / killall) is not allowed

Pattern kills match processes by name or command line, so they over-match:
they can reap another session's processes or unrelated tools, and they destroy
the evidence you need to find the real problem.

Do this instead:
  1. Enumerate — `ps`, `jobs`, or the tool's own status command.
  2. Identify each PID and confirm what it is and who owns it.
  3. Kill only the confirmed-redundant PIDs by number:
       kill <pid>     (or kill -TERM <pid>)

Kill one verified PID at a time. Targeted `kill <pid>` is allowed.
EOF
    ;;
  heredoc-interpreter)
    cat >&2 <<'EOF'
BLOCKED: a heredoc fed to an interpreter

A script piped into python, node, bash or another interpreter through a heredoc
is code nobody can read before it runs, and the harness stops to ask about it
even in bypass mode. A bare variable word such as `cd "$DIR" && git commit ...`
in the same command counts too.

Do this instead: write the script to a file in your scratchpad with the Write
tool, then run it by path, e.g. `python3 /path/to/script.py`. To commit with a
message body, use `git -C "<dir>" commit -F - <<'EOF'` instead of `cd`.
EOF
    ;;
  heredoc-file)
    cat >&2 <<'EOF'
BLOCKED: a heredoc written to a file

`cat <<EOF > file`, `cat >> file <<EOF` and `tee` write a file the harness
cannot show as a change, and it stops to ask about them even in bypass mode.

Do this instead: create the file with the Write tool, or change it with Edit.
Still allowed: `cat >&2 <<EOF`, `--body-file -`, and
`git commit -m "$(cat <<'EOF' … EOF)"`.
EOF
    ;;
  deletion)
    cat >&2 <<'EOF'
BLOCKED: a deletion whose target is only known when it runs

This rm or rmdir names its target through a variable, a glob, a command
substitution or a critical path (/ ~ . ..), or runs inside bash -c, xargs or
find. The harness cannot tell what it will delete, so it stops to ask even in
bypass mode.

Do this instead: name the path literally, as one absolute or worktree-relative
path per operand, in a call of its own:
  rm -rf /absolute/path/to/dir
A literal-path delete of a file or directory you own is allowed.
EOF
    ;;
  *)
    exit 0  # Couldn't parse, or nothing guarded found — allow (fail open)
    ;;
esac

echo >&2
echo "Do not re-issue, split, or script around this block; use the alternative, or ask on the board." >&2
exit 2  # Block the command
