#!/bin/bash
# Hook: Prevent merging PRs without reviews or bypassing the review requirement
#
# Input contract (FLOW-225): read the command from JSON on stdin, the way the other nine hooks in
# this directory do. This hook previously read $CLAUDE_TOOL_INPUT_command only, which is set by no
# other hook here and by none of the tests; under stdin invocation it exited 0 on every command,
# enforcing nothing. The env vars are kept as a fallback so the hook works under either contract.

set -uo pipefail

INPUT=""
if [[ ! -t 0 ]]; then
  INPUT=$(cat)
fi

TOOL_NAME="${CLAUDE_TOOL_NAME:-}"
COMMAND="${CLAUDE_TOOL_INPUT_command:-}"

# Guarded the same way the other hooks guard it (FLOW-183): under `set -e` an unguarded assignment
# from a failing or missing jq aborts the script before its intentional fail-open paths.
if [[ -n "$INPUT" ]] && command -v jq >/dev/null 2>&1; then
  PARSED_TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || PARSED_TOOL=""
  PARSED_COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || PARSED_COMMAND=""
  [[ -n "$PARSED_TOOL" ]] && TOOL_NAME="$PARSED_TOOL"
  [[ -n "$PARSED_COMMAND" ]] && COMMAND="$PARSED_COMMAND"
fi

# Only check Bash commands. An absent tool name means we could not identify the tool — allow, the
# same fail-open posture every other guard here takes on an unreadable input.
if [[ -n "$TOOL_NAME" && "$TOOL_NAME" != "Bash" ]]; then
  exit 0
fi

if [[ -z "$COMMAND" ]]; then
  exit 0  # No command, allow
fi

# Segment-scoped decision (FLOW-225). Emits one line per relevant segment:
#   ADMIN                  — a gh segment carries --admin, block outright (checked first, any segment)
#   UNPARSEABLE_MERGE       — parse failure, and the raw text carries a gh/pr/merge signature but no
#                             --admin match; distinct from ADMIN so the message doesn't claim --admin
#                             was seen when it wasn't
#   MERGE<0x1f><pr-ref><0x1f><pr-repo> — a real `gh pr merge` segment; pr-ref and pr-repo may each be
#                             empty (current branch / current directory's repo). The delimiter is the
#                             unit separator (0x1f), not a tab: tab is IFS whitespace, so bash's `read`
#                             would collapse a run of them and could not represent an empty middle field.
#   (nothing)              — no relevant segment, or unparseable with no signature at all; allow
# Every `gh pr merge` segment is emitted, not just the first — a line may carry more than one, and
# the bash loop below must check each one and block if ANY fails (same defect class as pr-title-guard:
# "first hit only" lets a second, unapproved merge through unguarded).
if command -v python3 >/dev/null 2>&1; then
  RESULT=$(python3 - "$COMMAND" 2>/dev/null <<'PY'
import bisect, re, shlex, sys

# FLOW-225 design decision: this segment tokenizer is duplicated, not extracted into a shared
# module, across six hooks -- see dashboard-enter-guard.sh (the canonical copy) for the full
# reasoning.

def raw_substitution_spans(command):
    # Defined in all six hooks for the shared-analyzer byte-identical convention, but only
    # called by the three unconditional hooks (process-kill-guard.sh, no-verify-guard.sh,
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
    # '(gh', '$(gh' never equal 'gh', and a closing '(...)' fuses onto the LAST token in the
    # segment -- '--admin)' never equals '--admin'. Strip both ends before comparing.
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
    # Basename so a path to the binary ('/usr/bin/gh') still matches.
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
    # KNOWN, NOT covered by this round: a wrapper that takes its OWN argument before the real
    # consumer ('timeout 5 $SHELL', 'nice -n 10 $SHELL') hides an opaque consumer this fix does
    # not catch, since only the bare wrapper NAME is skipped, not a following flag/value -- and
    # with $SHELL specifically, which bash sets itself whenever it is not already inherited, this
    # is live in EVERY environment, not a theoretical variable that happens to be unset in most of
    # them (an earlier draft of this note used $CMD, populated in essentially no environment,
    # which understated how live this gap actually is -- corrected after measuring both under a
    # bare 'env -i': $CMD genuinely inert there, $SHELL genuinely not). Not fixed in this round:
    # the argument shapes differ per wrapper (a duration, a niceness level, a signal number, ...)
    # and handling them would mean wrapper-specific parsing, a larger change than this report
    # covers. Flagged, not silently left, for the same reason every other scope boundary on this
    # ticket is written down instead of discovered later.
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
    # A run of '&'/'|'/';' merges with an adjacent run of newlines into one token in
    # punctuation_chars mode — strip the newlines out before comparing.
    core = tok.replace('\n', '')
    return tok != '' and (core == '' or core in OPERATORS)

segments = [[]]
for tok in tokens:
    if is_boundary(tok):
        segments.append([])
    else:
        segments[-1].append(tok)

if PARSE_FAILED:
    if re.search(r'(?:^|[\s\'"])--admin(?:[=\s\'"]|$)', sys.argv[1]):
        print('ADMIN')
    elif all(re.search(r'\b' + w + r'\b', sys.argv[1]) for w in ('gh', 'pr', 'merge')):
        print('UNPARSEABLE_MERGE')
    sys.exit(0)

def has_gh(seg):
    return any(normalize_bin(t) == 'gh' for t in seg)

def has_admin(seg):
    # The bare-flag check alone missed '--admin=true' entirely. Also match the
    # assignment form. Judgment call, made explicitly: this also blocks '--admin=false', which gh
    # treats as don't-use-admin -- but this ticket's standing principle is that a guard fails
    # toward blocking, nobody writes '--admin=false' in practice, and the recovery if they do is to
    # drop the flag rather than pass it explicitly. Blocking the whole assignment form is the
    # decision, not an oversight.
    return any(
        strip_shell_meta(t) == '--admin' or strip_shell_meta(t).startswith('--admin=')
        for t in seg
    )

merge_segments = []
for seg in segments:
    if not has_gh(seg):
        continue
    if has_admin(seg):
        print('ADMIN')
        sys.exit(0)
    for i in range(len(seg) - 2):
        if normalize_bin(seg[i]) == 'gh' and seg[i + 1] == 'pr' and seg[i + 2] == 'merge':
            merge_segments.append(seg[i + 3:])
            break

for span in raw_substitution_spans(sys.argv[1]):
    span = strip_heredocs(span)
    if re.search(r'(?:^|[\s\'"])--admin(?:[=\s\'"]|$)', span):
        print('ADMIN')
        sys.exit(0)

if not merge_segments:
    sys.exit(0)

# PR ref from EACH segment's own operands only — never the first number on the line. Tokens are
# meta-stripped first so a trailing '(...)' fused onto the ref itself ('295)') still isdigit()s.
#
# FLOW-225 F11 KNOWN LIMIT (not fixed here, not a regression — base has the same gap): 'gh pr
# merge' accepts <number> | <url> | <branch> as its ref operand, but only digits and /pull/ URLs
# are recognized below. A branch-name operand is silently dropped, so the guard falls back to
# checking the CURRENT branch's PR instead of the named branch's. Pinned as a live test in
# test-pr-merge-guard.sh ('KNOWN LIMIT: branch-name ref operand...'); see
# FLOW-225.
for seg in merge_segments:
    ref = ''
    repo = ''
    # What the NEXT token is: '' (an operand or flag), 'repo' (the value of -R/--repo), or 'value'
    # (the value of any other value-taking flag, discarded). A value must never reach the ref slot:
    # '-b https://.../pull/295' would otherwise have the guard check PR 295's approvals instead of
    # the PR actually being merged.
    consume_next = ''
    for raw_tok in seg:
        tok = strip_shell_meta(raw_tok)
        if consume_next:
            if consume_next == 'repo':
                repo = tok
            consume_next = ''
            continue
        if tok in ('--repo', '-R'):
            consume_next = 'repo'
            continue
        if tok in ('--body', '--body-file', '--subject', '--author-email', '--match-head-commit'):
            consume_next = 'value'
            continue
        if tok.startswith('--repo=') or tok.startswith('-R='):
            repo = tok.split('=', 1)[1]
            continue
        if tok.startswith('-') and not tok.startswith('--'):
            # A clustered short-flag token ('-tRvalue', '-sR', '-cRowner/repo', ...). Walk it left
            # to right per pflag's own cluster grammar for gh pr merge: d/m/r/s take no value and
            # the walk continues past them; A/b/F/t/R each take a value and consume the rest of the
            # cluster (or the next token when nothing remains) as THEIR value, ending the walk — so
            # an R found only counts as --repo when the walk reaches it still in flag position, not
            # merely because the letter 'R' appears somewhere in the token.
            boolean_flags = set('dmrs')
            value_flags = set('AbFtR')
            chars = tok[1:]
            i = 0
            while i < len(chars):
                c = chars[i]
                if c in boolean_flags:
                    i += 1
                    continue
                if c in value_flags:
                    remainder = chars[i + 1:]
                    if c == 'R':
                        if remainder:
                            # pflag strips one '=' after a shorthand: -sR=owner/repo is owner/repo.
                            repo = remainder[1:] if remainder.startswith('=') else remainder
                        else:
                            consume_next = 'repo'
                    elif not remainder:
                        consume_next = 'value'
                    break
                break
            continue
        if tok.startswith('-'):
            continue
        if not ref and (tok.isdigit() or '/pull/' in tok):
            ref = tok
    sys.stdout.write('MERGE\x1f' + ref + '\x1f' + repo + '\n')
PY
) || RESULT=""
else
  RESULT=""
fi

if [[ -z "$RESULT" ]]; then
  exit 0  # Couldn't parse, or no gh segment — allow (fail open)
fi

if [[ "$RESULT" == "ADMIN" ]]; then
  echo "BLOCKED: Never use --admin flag. All changes must go through normal review process."
  exit 2
fi

if [[ "$RESULT" == "UNPARSEABLE_MERGE" ]]; then
  echo "BLOCKED: could not safely parse this command to check review status, but it looks like a 'gh pr merge' invocation. Simplify the command (remove nested quoting/heredocs) and try again."
  exit 2
fi

# RESULT may carry one MERGE line per real invocation — check EVERY one, not just the first. The
# field delimiter is \x1f (unit separator), not a tab: tab is IFS whitespace, so `read` collapses a
# run of them and drops an empty ref field instead of preserving it.
while IFS=$'\x1f' read -r kind pr_ref pr_repo; do
  [[ "$kind" == "MERGE" ]] || continue

  # Build the argv so an empty pr_ref omits the operand entirely rather than passing "".
  gh_args=(pr view)
  [[ -n "$pr_ref" ]] && gh_args+=("$pr_ref")
  # FLOW-260 carry-in: carry the merge command's own --repo through to the review lookup. Without
  # it the lookup resolves against the CURRENT directory's repo, which from a multi-repo launch dir
  # is no repo at all — the guard then fails closed on every merge (it cannot verify approvals, so
  # it must block) and is unusable from the directory this workspace is documented to run in.
  [[ -n "$pr_repo" ]] && gh_args+=(--repo "$pr_repo")
  gh_args+=(--json reviews --jq '[.reviews[] | select(.state == "APPROVED")] | length')

  # A network call on the PreToolUse path with no timeout can hang the tool
  # invocation indefinitely, and without </dev/null the child inherits this loop's `<<<` here-string
  # as its own stdin, letting it consume remaining MERGE lines meant for later iterations. `timeout`
  # is guarded (not every environment ships GNU coreutils) so its absence can't turn every legitimate
  # merge into a block — this review-count path already fails closed on any `gh` failure by design
  # (an unverifiable approval count must not be treated as "no review needed"), so a missing
  # `timeout` binary must not silently make that intentional fail-closed apply to every call.
  gh_cmd=(gh "${gh_args[@]}")
  if command -v timeout >/dev/null 2>&1; then
    gh_cmd=(timeout 15 "${gh_cmd[@]}")
  fi

  if ! REVIEW_COUNT=$("${gh_cmd[@]}" 2>/dev/null </dev/null); then
    echo "BLOCKED: Could not fetch PR review status. Ensure you're in a git repo with an associated PR."
    exit 2
  fi

  if ! [[ "$REVIEW_COUNT" =~ ^[0-9]+$ ]]; then
    echo "BLOCKED: Could not parse PR review count from gh output."
    echo "Raw output: $REVIEW_COUNT"
    exit 2
  fi

  if [[ "$REVIEW_COUNT" -lt 1 ]]; then
    echo "BLOCKED: PR has no approvals. At least 1 team member must review before merging."
    echo "Current approval count: $REVIEW_COUNT"
    exit 2
  fi
done <<< "$RESULT"

# All checks passed
exit 0
