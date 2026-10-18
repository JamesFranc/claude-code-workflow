# Dashboard Protocol

This file is the single authoritative statement of the dashboard session and question/approval protocol. Consumer skills keep only their parameters and pointers here — do not re-copy this text into a skill file.

## 1. Session enter — mandatory first action

Entry skills run `dashboard session enter` as their first action, before any research or investigation — before reading code, before asking a single question — so every question item has a home from the first moment:

```bash
dashboard session enter --phase "<phase>" --title "<short description of the request>"
```

`--title` names a node on its first enter. On any later re-enter, omit it — the existing title is preserved automatically. Renaming a node you already entered requires `--retitle`, and the CLI refuses a bare `--title` that would change it (FLOW-180).

No `--key` — this is the root of the work. Its board node is minted fresh whenever this session has no live root recorded locally, so after `leave --root` (or `end`) the next `enter` starts a genuinely new top-level board session. If the recorded root is dead on the board, `enter` refuses **when it can tell** — its error then names the exact command to release it, which depends on whether the dead node is the root or a keyed child and whether it has children of its own. It can only tell when the installed `ai-workflow-app` reports `lifecycle` (REV-66); against an older build it attaches silently and the symptom is writes failing with `Session is closed`. Use a placeholder title (a short description of the request); the title and ticket link are filled in later. Run this on every run without exception. (If the `dashboard` CLI isn't installed the command no-ops on its own — run it regardless; never skip it on the assumption the dashboard is unavailable.)

**A ticket-level node is not fully entered until it carries its ticket link, once the ticket exists.** `dashboard session enter` mints or re-enters the node; `dashboard link add --kind ticket --label "<TICKET-ID>" --url "<jira-url>" --root` — or the same `--key` the `enter` used, when the minted node is a keyed child rather than the root — is what makes the ticket reachable from the board card, and the two belong together. Keyless is refused once the root has any children (FLOW-209), and passing the right flag is always correct — so pass one every time rather than reasoning about whether this run needs it. The obligation attaches to **every site that mints a ticket-level node**, not only to the sites that create the Jira ticket — a node minted by a skill that did not create the ticket (Team Dispatch entering an already-existing story, or a standalone ticket run) is exactly the case that used to lose the link silently (FLOW-206). A ticket-level node carries exactly one `kind:ticket` link, its own — a story under an epic root inherits the epic association from its parent node, not from a copied epic link. Use the ticket's canonical browse URL (the `webUrl` on the Jira response) — never a hardcoded Jira host. Run `link add` unconditionally: it is idempotent per node on `(kind, url)`, so re-registering a link an earlier skill already added is a no-op, not a duplicate.

**Per-skill parameters:**

| Skill | `--phase` | Title source |
|-------|-----------|--------------|
| `workflow:jtbd` | `prd` | short description of the user's request |
| `workflow:quick-change` | `change` | short description of the change |
| `workflow:systematic-debugging` | `debugging` | short description of the bug |
| `workflow:team-dispatch` (entry point, no front door ran) | `dispatch` | the ticket summary |
| `workflow:renovate-prs` | `renovate` | the monitored scope, retitled to a one-liner only for an outcome that decides nothing (never for a stop that asks a question) |

**Root vs. keyed semantics:** see *Dashboard Session Nesting* in `skills/workflow-guide/references/routing.md` — nodes are created by `dashboard session enter`, nesting comes only from `--key`/`--parent-key`, and re-entering an existing node with a new `--phase` creates no new node.

**FLOW-147 note:** `dashboard session enter` also records the workflow marker the edit gate checks — it is not only a board-visibility action.

### The ticket node key — never write the ticket id as a `--key`

`enter` composes a node's identity from its key (`externalId = <root>:<key>`), so **a `--key` naming
this ticket IS the node, not a reference to it.** The restart recovery
(`commands/restart-jobs.md`) re-establishes a dead ticket node under a *new* key —
`<TICKET-ID>-resumed`, then `-resumed-2`, … — so a hardcoded `<TICKET-ID>` recomposes the dead
node's id and the register upsert reactivates it.

**Every site that RE-ENTERS a ticket node resolves the key instead of writing it:**

```bash
TICKET_NODE_KEY="$(dashboard session key --ticket "<TICKET-ID>")" || exit 1
dashboard session enter --phase "<phase>" ${TICKET_NODE_KEY:+--key "$TICKET_NODE_KEY"}
```

Run both lines in the **same** shell invocation — a shell variable does not survive between separate
commands.

**`${VAR:+--key "$VAR"}` is unquoted on the outside on purpose.** That is what lets it expand to *zero
words* when the lookup found nothing, so the enter is keyless. The inner quotes still protect a key
containing spaces. Writing `--key "${TICKET_NODE_KEY:-<TICKET-ID>}"` instead would pass
`--key <TICKET-ID>` in the zero-match case — and zero matches means the ticket **is** the dashboard
root, where a keyed enter mints a spurious child node under it. That fallback re-introduces exactly
the literal this section forbids.

**A non-zero exit means two or more live nodes matched, both named on stderr.** Do not fall back and
do not retry — decide which node the work belongs to and pass `--key` explicitly. Note the guard also
fires when the `dashboard` binary is absent (exit 127), aborting the rest of the block; that is
harmless only because every command after it in these blocks is itself a dashboard command that
no-ops without the binary. **Do not put a non-dashboard command after the lookup in one of these
blocks.**

**Inside a branch whose precondition asserts the node already exists** — "when this ticket is a story
under a multi-story epic node **entered earlier this session**" — zero matches is not a case to fall
back from, it is proof the branch was taken wrongly. A keyless enter there attaches to the **epic
root**; `--key <TICKET-ID>` mints a duplicate or reactivates the dead node. Neither fallback rescues an
impossible state. Those sites pass `--require` and let the guard stop them:

```bash
TICKET_NODE_KEY="$(dashboard session key --ticket "<TICKET-ID>" --require)" || exit 1
dashboard session enter --phase "<phase>" --key "$TICKET_NODE_KEY"
```

**No `--key` position anywhere in these skills holds a literal `<TICKET-ID>` any more.** That is the
point of the ticket, and a fallback is precisely how it shipped unfixed twice.

`--label` is unaffected — it is a display string, not an identity. `link add --label "<TICKET-ID>"`
keeps the raw ticket id while its `--key` takes the resolved value.

**Sites that MINT a node keep the literal `<TICKET-ID>`** — a node created for the first time takes
the canonical key by definition, and there is nothing yet to look up. (FLOW-137, FLOW-207.)

### CLI availability — two different failures

**A missing `dashboard` wrapper is not the same failure as a present wrapper that cannot resolve
`ai-workflow-app`.** A missing wrapper exits 127 before any dashboard command runs, so every dashboard
verb no-ops on it alike — this is what "the CLI is absent" means elsewhere in these skills unless a
site says otherwise.

A present wrapper that cannot resolve `ai-workflow-app` is a second, narrower failure. All 20
dashboard verbs — `session enter`/`key`/`leave`/`heartbeat`/`end`/`status`/`repair`, `link add`,
`item add`/`answer`/`approve`/`reject`/`show`/`withdraw`/`consume`/`drop-deferred`/`list-deferred`/`flush-deferred`,
`answers`, `comments` — split five ways under it, and every one of the 20 falls in exactly one arm:

Both failures above are *resolution* failures — a binary not found at all — but not of the same
binary: the first cannot find `dashboard` and exits 127 before any resolution of `ai-workflow-app` is
attempted; the second finds `dashboard` but not `ai-workflow-app`. It is that second failure —
`ai-workflow-app` failing to resolve — that the rest of this section is about. A resolved binary
whose call itself then fails or times out is a different case: `dashboardAvailable()`, the gate the
next arm calls directly, tests only whether `ai-workflow-app` resolves (`resolveDashboardBin() !==
null`) and returns true regardless of whether a later call to it succeeds — and the live board check
the arm after that falls through to is no stricter, since it only runs once resolution has already
succeeded. Under `### CLI availability — two different failures`, "unreachable" and "does not
resolve" mean that resolution failure specifically; a resolved binary that fails when actually
invoked passes every such gate and fails loudly instead, inside whichever call it reaches — stderr
plus a non-zero exit, the same as any other failing invocation here (`invoke.ts`'s
`invokeDashboardBin`, `quiet` unset).

- **Silent no-op** (exit 0, nothing on stdout or stderr, nothing written) when `ai-workflow-app`
  does not resolve — `link add`, `item consume`/`answer`/`approve`/`reject`/`withdraw`, `session
  heartbeat`: each gates the board call before anything else runs, as the literal first line of its
  own handler for `link add`, `item consume`/`withdraw`, and `session heartbeat` — and, for `item
  answer`/`approve`/`reject`, as the first line of `resolveItem`, the shared helper each of those
  three delegates to as its entire one-line body. Either way, a wrapper that cannot resolve
  `ai-workflow-app` skips the whole verb before anything else runs. "Run it regardless — it no-ops on
  its own" is true for all seven under that failure only. A binary that resolves and then fails when
  called is a different case, and what happens next differs across the seven: `session heartbeat`
  resolves its target purely locally — no board call anywhere in its resolution chain — and reaches
  `invokeDashboard` directly, which fails there instead — loudly, not silently. The five item verbs
  resolve via `resolveSessionTargetOrRefuse`, which delegates to `resolveSessionTarget`, whose
  branches naming `ai-workflow-app` unreachable are gated behind their own, separately-resolved `bin
  === null` check (`resolveDashboardBin()` is not memoized, so this check is not guaranteed to agree
  with the gate above it) — where that check finds the binary still resolving, resolution instead
  refuses in one of the five ways §2's `list-deferred` paragraph enumerates from "For the three
  verbs in this paragraph", and `invokeDashboard` is reached only once a target actually resolves —
  with one exception: `dashboard item withdraw` with neither `--item` nor `--all` targets no session
  at all, so it invokes the backend bare instead of resolving one. `link add` resolves via
  `resolveLinkAddTarget` instead — a different resolver, not a shared one — which adds its own
  `--root`/`--key`/`--session` targeting refusals ahead of a tail call into that same
  `resolveSessionTarget`: a mutual-exclusivity refusal, a missing-local-root refusal, and an
  active-children refusal, none of which §2's five enumerate. `link add`'s refusal set is therefore
  a superset of the five, not the five themselves, though the does-not-resolve gate and the
  fail-loud-once-invoked property both still hold identically. The rest of this arm shares its
  exit/stdout/stderr shape but not always its reason:
  - `session key --ticket` makes no board call at all, reachable or not — the lookup is purely
    local (the registry) by design, so `ai-workflow-app`'s availability changes nothing about what
    it does; it is not "gated," there is nothing to gate.
  - `session end`, on the default path (nothing entered, or a bare `end` with zero or one live
    leaves), runs its local cleanup (registry-node removal) regardless of
    `ai-workflow-app`'s availability. `dashboardAvailable()` gates the corrupt-state refusal, the
    open-items withdraw, and the board's own `session end` call as one block, not that last call
    alone. It is silent under this condition because that local cleanup happens to write and print
    nothing here, not because the verb skipped itself the way the seven above do.
  - **`session enter` sits in this arm with one exception: it is silent (exit 0, nothing on stdout
    or stderr) but not inert.** Before it ever checks whether the bin is reachable, it attempts the
    local marker write the edit gate reads (`markWorkflowEntered`, FLOW-147) — that attempt, made
    regardless of `ai-workflow-app`'s availability, is what "run it regardless" rests on here, not a
    guarantee that the write lands: the attempt itself is skipped when neither `--session` nor
    `CLAUDE_CODE_SESSION_ID` resolves to a session id, and an earlier `--retitle` guard can throw
    before reaching it; the write it does make is an ordinary file write, not one exempt from
    failing (a full disk, a permissions error). Registering the leaf on the board is a separate,
    later step gated on a successful `session register` call, so under this condition `enter` writes
    `~/.claude/workflow-state/sessions/<id>/workflow-<hash>.json` and nothing else — and because
    that marker is exactly what the edit gate reads (`workflow-state check`, measured 3 → 0 across
    this call, no registry file written either side), this write is also where local edit rights
    open while the board registers nothing for the session. enter.ts's own comment on this write's
    ordering already says why it cannot be skipped: "a refused enter must not leave edit rights
    behind."
  - **`item show` is silent, but not by a first-line gate.** It makes no availability check of its
    own: it calls the board and treats the "could not resolve the binary" return as the no-op. The
    outcome under this condition is the same as the seven above — exit 0, nothing written, nothing
    printed — but the reason is one resolve rather than a gate plus a resolve: the same
    single-resolve pattern `status.ts` uses, and for the same reason (a second resolve can disagree
    with the first). Read it as "run it regardless" like the others; do not read it as "checks
    first, then calls."
  - `answers` and `comments` are silent for the same reason as the seven above — the gate is the
    first line of `readReleased`, the shared helper each delegates to as its entire one-line body —
    but their silence must not be read as "the board was checked and had nothing": when the app IS
    reachable and genuinely has nothing released, both print `No released
    answers for this session.` (or `comments`) to stdout instead of nothing. Under this condition
    neither message appears — silence here means "never asked," not "asked, got zero."
- **Hand-back** (exit 3, the composed item on stdout, nothing posted or queued, local state
  untouched) — `item add`, `--defer` included. It is not a refusal: the caller is meant to ask the
  printed question in the terminal and wait there (§2). `item add` resolves the board binary
  first; only with none does it compose and validate the question, so a bad flag still refuses with
  exit 1 rather than handing back, and no session target resolves.
- **Loud refusal** (exit 1, stderr, nothing posted, local state untouched) — `item flush-deferred`,
  with its own message ("cannot flush the deferred queue").
- **Resolves locally when a leaf or key exists — loud otherwise, and "otherwise" is not rare** —
  `item list-deferred` and `item drop-deferred`: neither of the two calls
  `resolveDashboardBin` directly, but each still calls `resolveSessionTargetOrRefuse`, which
  delegates to `resolveSessionTarget` and resolves purely locally — no dependency on
  `ai-workflow-app` — whenever a registry leaf, a matching
  `--key`, or a `--session` found in the local registry is available. **That is not the normal case
  for a session whose app has been unreachable throughout:** `session enter` attempts the local
  workflow marker write (previous bullet), but writes the registry leaf only after a successful
  `session register` board call — a call it never makes while `dashboardAvailable()` is false at
  entry — so such a session has no leaf, and the keyless zero-leaf path is its default state, not an
  edge case. On that path `resolveSessionTarget` falls through to a live board check (§2's
  `list-deferred` paragraph describes the same fallback), and there, an unreachable
  `ai-workflow-app` makes the check itself fail, so `resolveSessionTarget` throws — caught by
  `resolveSessionTargetOrRefuse`, the wrapper both verbs actually call, not propagating past
  it — and both verbs in this arm surface the identical remedy, "Make ai-workflow-app
  reachable, then run `dashboard session enter`." **A drain loop that repeats
  `list-deferred`/`flush-deferred` until the queue reports `[]` does not terminate under this
  condition**, the same hazard `flush-deferred`'s own guard names explicitly, unless the loop also
  checks the exit code: the refusal never produces the queue's true state, empty or not, on stdout,
  so a loop that only compares output against the literal `[]` sees neither an empty queue nor a
  diagnostic, and spins.
- **Exits 0 while still doing something** — `session leave`, `session status`, `session repair
  --forget`: three verbs, none of them silent despite the successful exit code, and no two of them
  the same shape:
  - `session leave` on the keyless zero-leaf path writes a two-cause stderr message and requests no
    non-zero exit — reported as "nothing to leave," not refused, because there genuinely is nothing
    to leave and no retry changes that.
  - `session status` writes a full report to stdout (`raw session: … dashboard: unavailable …`) —
    this is its normal output whether or not the board is reachable, not a fallback. Its `board
    nodes:` section distinguishes the two zero-node causes explicitly: `(unknown — dashboard
    unavailable, not checked)` when the app could not be reached, `(none)` only when the board was
    actually queried and genuinely had nothing for this session — the two no longer share a
    rendering.
  - `session repair --forget <id>` writes `repairing … N write(s): done: …` to stdout and an
    empty-`nodes` registry file to disk — a real write, behaviourally equivalent to no registry
    existing but not itself a no-op.

"Run it regardless — it no-ops on its own if the CLI is absent" holds, when `ai-workflow-app` does
not resolve, only for the silent-no-op arm above (`session enter` included, with the local-marker
caveat; `answers`/`comments` included, with the caveat that their silence must not be read as an
empty board). It does not hold for `item add` (hands the question back with exit 3, to ask in the terminal) or
`item flush-deferred` (loud refusal), for `item list-deferred`/`item drop-deferred` on the keyless zero-leaf path (loud, and that path
is the default for a session that entered while `ai-workflow-app` did not resolve, not a rare one),
or for `session leave`/`session status`/`session repair --forget`, each of which does something on
disk or on the terminal even while exiting 0. None of this holds a second time for a binary that
resolves and then fails when called: every verb on this page that reaches such a call fails loudly
there, silent-no-op arm included — with one exception: the open-item guard behind `item add`
(outside `--defer`) and `item flush-deferred` passes `quiet` on its board read, so that read warns
on stderr without the non-zero exit and the guard fails open. That is the case this section's
definition of failing loudly — "stderr plus a non-zero exit" — excludes with its `quiet` unset
qualifier.

## 2. Question protocol

**A question is earned before it is posted.** `skills/board/references/escalation-contract.md` governs whether the question earns the board: the three rungs — ask yourself, look it up, ask a teammate — and the five bright lines that are genuinely the user's, plus the sixth route for a **technical** disagreement you and a teammate could not settle on evidence, and the seventh for a fact only the user holds. A question none of them admits is not asked in the terminal instead; you decide it. This section governs everything after that point. A question that has not cleared the rungs is not a protocol violation you can fix by posting it better; it is a call you were supposed to make.

**Every question carries four things.** A **lede** — the first line of `--prompt` is the decision in one line, in plain language, actionable on its own: no agent-speak, no preamble, no restating the ticket. A **recommendation** — what you would do; there is no question for which this is unanswerable, and a pure taste call still has one. **What stalls** — what is waiting on the answer, or the literal word `none`. And **why it is the user's** — `taste`, `scope`, `risk`, `teammate-unsettled`, or `fact`. The evidence goes directly after the lede — what you checked, the options, and a pointer to what the user would have to look at (the PR link, when flushed against a diff) — and the last three close the item on a declaration line, in the exact form the contract's §Required question form gives — the CLI composes that line itself from `--recommend`, `--stalls`, and `--why-mine`, so it is never written by hand in `--prompt` (see below).

**Verify before you post** — the rule, and what to re-check, are in `skills/board/references/escalation-contract.md` §Required question form. `dashboard item withdraw` is for when you were wrong, not a substitute for checking.

**A question that stalls nothing waits for the diff.** Post a blocking question the moment it fires; hold a non-blocking one and, once a PR exists, post it as one item per question against the PR, so the user has code in front of them — and only where a PR is actually coming, since a workflow that produces none has no terminus and the question posts now (`skills/board/references/escalation-contract.md` §Blocking vs. deferrable). **Two kinds never qualify, however little they seem to stall:** a deferral-gate question (contract rule 5), and any question about the advancing PR's own content, scope, or review findings. §3 names both as always entangled and never judgement calls. A deferral-gate question is **recorded** the moment it fires — with a board, `--defer` queues it on the node, and `dashboard item flush-deferred` posts it later: against the diff where one exists, or, in a workflow that produces no PR, with no `--context` at all. With no board there is no queue to flush: `item add --defer` exits 3 and prints the question, and you ask it in the terminal now and wait for the reply. A question about the advancing PR's own content, scope, or review findings still **posts** the moment it fires. When you are unsure whether it blocks, it blocks. Never hold a question that blocks.

Only when you actually have a question for the user — never while you are still researching (mid-research the session should read as "working", i.e. no open items) — post it to the dashboard FIRST, then mirror it to the terminal (with no board, `item add` exits 3 and prints the question: ask it in the terminal and wait):
`dashboard item add --type question --recommend "<one line>" --stalls "<what waits|none>" --why-mine "<taste|scope|risk|teammate-unsettled|fact>" --prompt "$(cat "<tmpfile>")"` → capture `<id>` — round-trip `--prompt` through a private temp file, never a shell string: rich markdown routinely quotes code, and a backtick or `$var` in it mangles the command the same way an unguarded `--response` does (§4). Write the prompt to `<tmpfile>` first (`umask 077; mktemp`), then `rm -f "<tmpfile>"` once posted. The CLI validates `--recommend`, `--stalls`, and `--why-mine` and composes them into the declaration line itself — do not write that line by hand in `--prompt`. `--recommend` and `--stalls` are capped at 200 characters each, the lede (the first line of `--prompt`) is capped at 200 characters, and the full composed prompt is capped at 1500 characters — evidence that does not fit goes in the evidence block as a link, not inlined into these fields. `--recommend` and `--stalls` must also be single-line, with no CR or LF, and must not contain a `" · "` delimiter (or an NFKC-equivalent form of it), a leading or trailing `"·"`, or a `"**Label:**"` marker — these reproduce the declaration line's own grammar and are refused. In `--prompt`, a `" · "` delimiter (or an NFKC-equivalent form of it) is refused anywhere — in the lede and in the evidence alike — while a `"**Label:**"` marker is refused only on a line whose trim starts with `>`. Add `--defer` when this is a deferral-gate post under contract rule 5 (which requires `--stalls none`) — with a board it **queues** the question on this node instead of posting it, printing `{"deferredId":"<id>"}` (with no board, `item add --defer` exits 3 and prints the question, to ask in the terminal now), and `dashboard item flush-deferred` posts every queued question as its own board item, all in one call, once there is a diff to point at (or, in a workflow with no PR, with no `--context`) (below). Since nothing reaches the board yet, mirror the queuing to the terminal the same as a posted question is mirrored — the `deferredId` is what the user (and a later flush) addresses it by. Same field validation (grammar, single-line, the 200-character caps on `--recommend`/`--stalls`/the lede) and same required flags — but not the same composed-prompt cap: queuing measures the entry against the flush's own shape, which adds a "Deferred at `<phase>`" line beyond what an immediate post composes, so a question that just barely fits without `--defer` can still be refused with it. Give the prompt enough markdown context to decide in place — the lede, then the evidence with the options and any links, and nothing else: `--why-mine` already carries why it is yours, and restating it in prose is the padding `skills/board/references/escalation-contract.md` §Required question form forbids. If you have several **independent** questions, post them all in the same turn (one item each) so the user answers them in one visit rather than being pulled back repeatedly; ask **dependent** questions (where each answer shapes the next) one at a time. If a question you are about to post could change an **advancement** approval (§3.1) you have already asked the user for, withdraw the approval first (`dashboard item withdraw --item "<id>"`), then post the question — just the question; the withdrawal is already visible on the board and needs no explanation in the prompt or in-session. Never hold the question to keep the approval alive. After the user answers a question posted to the board, reconcile **by how they answered**: `dashboard item consume --all` when they answered on the dashboard, or, in the terminal, round-trip their answer through a private temp file rather than a shell string — `dashboard item answer --item "<id>" --response "$(cat "<tmpfile>")"` (full form and why: §4). With no board nothing was posted, so the terminal reply is acted on directly and there is nothing to reconcile. Nothing about the workflow outside the story you are working is composed here: a wrong step, a refusing CLI, a rule against a rule is a note in the process improvement file, and so is the fix you would propose for it (`skills/board/references/escalation-contract.md` §Workflow improvements are notes).

**References tie an item to the one it follows from.** `dashboard item add` takes `--answers "<id>"`, `--replaces "<id>"` and `--related "<id>"`, on every item type. Each is repeatable, and each names another item on the same board session. The board shows the reference on both items, and a hover or click on one takes the user to the other.

- **`--answers` is required** on the item that replies to a user comment, which every comment gets unless §6 exempts it. Name the comment's id.
- **`--replaces` is required** on an item that takes the place of one you withdrew. Name the withdrawn item's id.
- **`--related`** is your call, for an item that is about another one without answering or replacing it.

With `--defer`, the references stay on the queued entry, and `flush-deferred` posts them with it. The app refuses a reference whose item is missing, deleted or on another session. An immediate post then posts nothing. A flush keeps the entries it already posted, stops at the refused one, and leaves it and every later entry queued: read the entry with `dashboard item list-deferred`, `drop-deferred --id "<id>" --reason "<why>"`, then re-queue it with `item add --defer` and corrected references.

**Three verbs manage the deferred queue.** `dashboard item list-deferred` (`--session`/`--key` to target a node other than the current one) prints this node's queue as JSON; an empty queue prints `[]`. It resolves its session target the same way `drop-deferred` and `flush-deferred` do, and refuses the same five ways — not the way every `--key`-accepting item verb does: `withdraw`, `consume`, `answer`, `approve`, and `reject` gate on `dashboardAvailable()` before ever reaching this resolution, and `item add` — `--defer` included — checks `resolveDashboardBin()` directly, the same does-not-resolve condition `dashboardAvailable()` wraps, and with no board exits 3 before resolving anything; with a board, `--defer` then resolves the way this paragraph's three verbs do. §1's CLI availability section states exactly what that gate covers and does not cover, for both of `ai-workflow-app`'s unavailable cases; it is not the same condition for every verb named here, which is why this paragraph points there rather than restating it. For the three verbs in this paragraph: no session id at all — no `--session` and no `CLAUDE_CODE_SESSION_ID` — refuses immediately, purely locally, and this check runs before `--key`'s, so a bare `--key` with neither of the other two present hits this refusal, not the not-found one below; an ambiguous session with no `--key`/`--session` to disambiguate refuses immediately, purely locally; `--key` naming a node absent from the local registry has no board check to fall through to and refuses immediately; the keyless case with no local node at all falls through to a live board check (`resolveViaBoard` — is there an active root for this session) before refusing as "no active board session for this Claude session — run `dashboard session enter` first"; and an explicit `--session` naming a node absent from the local registry falls through to a different live board check (`isLiveBoardNode` — is *this id* live), refusing as "not a live node for this session (checked the local registry and the board)" — the two share only the board-check fallthrough, not the probe or the message, so this is not always a purely local read. And once resolved, all three refuse alike on a present state file that is corrupt — unparseable (truncated, corrupted), or parsing with a shape-invalid `deferredQuestions` field — before the queue is even read; this guard is shared identically by `list-deferred`, `drop-deferred`, and `flush-deferred`, not peculiar to any one of them. `dashboard item drop-deferred --id "<id>" --reason "<what answered it>"` removes a queued entry the work itself answered; the reason is printed with the result and never reaches the board — the user reads only the questions still open. `dashboard item flush-deferred --context "<pr url>"` (`--context` is optional — omit it in a workflow with no PR) posts every queued entry as its own board question, in queue order, in one call, and removes each entry as its post is confirmed — a post that fails part-way leaves the unposted remainder queued and reports it, so a retry posts only what is missing. `--context` is validated first, before any session or state is touched: blank is refused at the flag-parsing layer; a `--context` carrying a CR or LF is refused, since it is the last evidence block, composed on one line; `--context` alone over 200 characters is refused; and `--context` reproducing the declaration line's own grammar (a `" · "` delimiter or a blockquoted `"**Label:**"` marker) is refused. Only past that does it check the board binary is resolvable — a loud stderr refusal and exit 1, queue left untouched, when `ai-workflow-app` cannot be reached — and then resolve its session target, the same way list-deferred does, above, refusing the same five ways described there. Beyond that it refuses outright, posting nothing, when: an approval is already open on the node (§3.1's exclusivity, checked before posting — this check is itself fail-open on an unreadable board read, the same five ways §3.1's own approval guard is, and it never runs at all when the queue is already empty, since the empty-queue case returns before it); any queued entry composes past the composed-prompt cap — whether `--context` pushes an entry that would otherwise fit past it, or the entry itself is already too large with no `--context` at all — naming the entries and the actual cause, and posting nothing; the board call itself fails once attempted — available but erroring or timing out, reported by the call, queue left queued; or a board post returns no id, leaving that entry and everything after it queued, since an unconfirmed post is not a confirmed one. Review before you flush: `list-deferred`, drop what the work already answered, then flush — never flush blind.

## 3. Approval-gate protocol

**Precondition (§3.1):** a document's approval-to-proceed is an advancement approval. If a question that could change this document is open, **hold it** — wait for the answer, then post as your next action once that question resolves. That obligation is yours, not the CLI's: `dashboard item add --type approval` refuses the post when it can confirm an open question on this node, but it **fails open** whenever it cannot (§3.1, *The guard is a backstop*), so a post that succeeds is never evidence the board was clear. Decide under this rule first. For a single-shot doc approval you may then let the guard catch you if you got it wrong — it has nothing to unwind if refused — but that is a second line, not the check itself. (PR Lifecycle's two event-handler sites read the board *before* posting rather than relying on the guard, because they run off an async monitor where a stale premise is more expensive to unwind than a refused post — see their own precondition text.)

Once no question that could change this document is open, with a board post the approval to the dashboard before waiting for it: write `<rich markdown: doc one-liner + link + "approve to proceed to <next phase>">` to `<tmpfile>` (temp file, never a shell string — why: §2), then `dashboard item add --type approval --prompt "$(cat "<tmpfile>")"` → capture `<id>`, then `rm -f "<tmpfile>"`. The prompt is that one-liner, the link, and the ask — nothing else. An approval carries no `--why-mine` (the CLI refuses it here), and that is not an invitation to supply one in prose: a sentence naming whose call this is, or explaining what the state you just reported implies, is the padding `skills/board/references/escalation-contract.md` §Required question form forbids, and it is forbidden here in the same words. With a board, only after that does the terminal notification go out. With no board, `item add` exits 3 and prints the approval: ask it in the terminal and wait for the reply; nothing was posted, so there is no `<id>` to capture.

**Approval reconcile** (an approval posted to the board; with no board there is nothing to reconcile): `dashboard item approve --item "<id>"` when the user approved in the terminal, or `dashboard item consume --all` when they approved on the dashboard.

### 3.1 An advancement approval is exclusive

An **advancement approval** asks the user to move the work forward: flip a PR to ready-for-review,
merge it, proceed to the next phase on a document, or any other approval whose purpose is to signal
the work is finished — the list is illustrative, not exhaustive. It asserts *this is finished*. An open
question asserts *this is still being decided*. Both on one node at once asks the user two
contradictory things, and the cost lands on them: they answer the question, then have to reject the
approval and type a reason that only restates the answer they just gave (FLOW-211).

The rule runs in both directions, because both orderings happen:

- **Never post an advancement approval for X while a question is open whose answer could change
  X.** Hold it. Post it as your next action once that question resolves — not later.
- **If such a question is open at all while an advancement approval for X is already posted,**
  withdraw the approval first (`dashboard item withdraw --item "<id>"`), and post a fresh approval
  once X is genuinely ready, with `--replaces "<id>"` naming the one you withdrew (§2). The withdrawal is visible on the board; do not explain it in the
  question's prompt or in-session — the user reads the question, not the history behind it.

**A deferred question counts the same as a posted one, without the judgement call.** A question
queued with `--defer` is open work the board cannot yet see: no advancement approval is posted for
this node while any open question remains, deferred or not — there is no "this one
couldn't change it" exemption for a queued entry the way there is for a posted one. With a board the ordering is fixed: **push,
flush, answer, approve.** The branch goes up first, so every flushed question points at code the
user can actually read; every queued question posts as its own item, in one call (`dashboard item flush-deferred --context
"<pr url>"` — or with no `--context` in a workflow with no PR); the user answers them; only then does the advancement approval go up. **The CLI does not enforce the other direction:** `--defer` itself is not refused while an advancement approval is already open on the node — only the approval post and the flush are guarded. Do not queue a new deferral once you have posted an advancement approval for this node; drop or flush what is already queued, or wait for the approval to resolve, before deferring more. A question the
work itself answered before the flush is dropped first (`dashboard item drop-deferred --id "<id>"
--reason "<what answered it>"`) — but nothing is dropped merely to clear the way for an approval
faster.

The test for a *posted* open question: *if the user answers this the way they plausibly might, does
what I am asking them to approve change?* If yes, the two are not independent.

**The CLI's guard cannot evaluate subject — whenever it reads a count above zero it blocks, full
stop.** If your own judgement says a particular open question could not change this approval, the
guard does not share that judgement and refuses anyway. That is not a bug to route around: the
required action is still **wait**, the same as everywhere else in this rule — never reach for
`--approval-kind` (reserved for the three exemption categories below, never for "this one doesn't
count") or `--type question` to get past a refusal you believe is over-broad. Mechanically, the
guard reads that count only for an approval that declared no `--approval-kind`; a declared HOLD,
credential, or checkpoint returns before it is ever fetched. That is a statement about what the CLI
inspects, not a category you may argue your way into — which approvals may declare one is settled
below, and it is never a judgement about the open question.

**The guard is a backstop, and this rule binds you whether or not it fires.** The check reads this
node's open-**question** count *from the board*, and whenever it cannot get a trustworthy count it
**fails open and posts**. That happens in five cases:

- the board is unreachable;
- the `session list` payload does not parse — including when the malformed row belongs to some
  *other* system's session: the row-is-an-object and session-is-an-object checks run before the
  per-system filter, so a row failing either one aborts the whole read no matter whose session it
  is (the later checks, on `externalId` and `id`, only see rows already matched to this system);
- this session resolves to no board node;
- the session id is unavailable, so there is nothing to scope a read to and no read is attempted at
  all — reachable only when the caller passes an explicit `--session`, because without one the
  command throws on the missing id before it ever reaches this guard;
- the per-type `openItemCounts` breakdown is missing or malformed. An `ai-workflow-app` predating
  REV-72 reports none at all; a *current* backend reporting a partial, negative, or non-integer
  breakdown is rejected exactly the same way.

Failing open is deliberate — a guard that refused on a failed read would strand a workflow behind an
outage rather than protect anyone — but it has two consequences you have to carry. **A post that
succeeds proves nothing:** it does not mean the board was clear, it may mean the guard could not
see. And **you will usually get no hint that it could not see** — only the unreachable-board case
leaves anything on stderr; the other four are silent, and the last two involve no failed read at
all. So never treat "the CLI let me" as having performed the check, and never let a stretch of
successful posts persuade you the rule is being enforced somewhere on your behalf. The judgement
above — *could their answer change what I am asking them to approve?* — is the enforcement. The
refusal is only what catches you when you get that judgement wrong, on the runs where it can see at
all.

**The deferred-queue half of this guard does not share that weakness.** It reads local session state,
not the board, so none of the five fail-open cases above apply to it. Local state is itself a file on
disk, but a missing one and a present one that is corrupt — unparseable (truncated, corrupted), or
parsing with a shape-invalid `deferredQuestions` field — are not treated alike: absent reads back as
no queue, correctly, since a node that has never deferred anything has nothing pending; corrupt
refuses the post outright either way — `dashboard item add` itself refuses before ever reaching this
check, the same guard that protects every other read of this file, so the approval never reaches the
board on a corrupt file at all. Every other queued open
question blocks the post as intended. It governs advancement approvals only: a HOLD, credential, or checkpoint approval returns
before this check — or the board-count check above it — ever runs (§3.1, *the guard reads that
count only for an approval that declared no `--approval-kind`*), so a deferred queue never blocks
one of those three.

**When you are unsure, hold.** The asymmetry is one-sided: holding costs one board round-trip;
posting early costs the user a rejection they have to compose **and** the same round-trip. Holding
is never the more expensive mistake.

Cases that are always entangled, not judgement calls:

- Any question about the PR's content, scope, or review findings, while that PR is what advances.
- A deferral-gate question (contract rule 5) — "fix it here" is one of its two answers by
  construction, so it can always change what ships.

**Exactly three** kinds of approval are not advancement approvals, and all three are recognisable
from the approval alone, without reference to the open question:

- a **HOLD** item — it withdraws advancement rather than requesting it;
- a **credential / auth / environment ask** — it is not advancement at all;
- a **checkpoint** — the harness paused the session (a usage limit, a stalled teardown, or a
  similar external stop) with nothing for the user to decide, only to act on.

There is no fourth "unrelated subject" category. *"An approval the open question cannot change"* is
not an exemption, it is this rule's own precondition restated — the rule already reads "an item whose
answer **could change** X". Listing it as an exemption teaches that "not an advancement approval" is
a judgement about entanglement, which hands back the exact escape the definition above exists to
close. A concrete false case: *"this approval is about the deploy config, not the code the open
question is about"* sounds like a plausible unrelated-subject claim, and it is exactly the escape
this rule closes — the deploy-config approval still asks the user to move something forward, and it
is not one of the three exemptions above, so it holds like any other advancement approval,
subject-matter argument notwithstanding.

**Passing `--approval-kind` on anything other than these three cases is prohibited, not merely
undocumented — unconditionally, regardless of whether the guard is currently enforcing anything.**
Declaring `hold`, `credential`, or `checkpoint` on an approval that is actually advancement is the
FLOW-211 defect this rule exists to close, restated as a false claim on the enum instead of an
omitted check — it is not a fourth way to satisfy the guard, in any REV rollout state. The CLI's
refusal and this rule's definition agree exactly: anything not declared `hold`, `credential`, or
`checkpoint` **is** an advancement approval by this rule's own construction (the "Exactly three"
paragraph above) — there is no case where the CLI refuses something that "isn't really advancement."
If refused, the required action is the same as everywhere else in this rule: **wait**. Never reach
for `--approval-kind` to route around a refusal, and never fall back to `--type question` either —
that drops the approve/reject affordance the user needs and downgrades an item that is genuinely an
approval. A further evasion is retargeting: posting the advancement approval against a different node
(a different `--session` or `--key`) than the one the open question actually lives on, so the guard's
per-node check finds nothing there to refuse. The rule is about the work being entangled, not about
which node happens to record which item — retargeting to dodge a refusal you know is warranted is
the same misuse as the other two, even though the guard itself cannot always tell.

**All three still have to declare themselves, because the CLI cannot tell.** All three post as
`dashboard item add --type approval`, and nothing in a prompt string distinguishes "do not merge
this" from "please merge this" from "the session paused, nothing to decide." So those three paths
pass `--approval-kind hold`, `--approval-kind credential`, or `--approval-kind checkpoint`.

**The flag supplies a missing fact, not a permission.** It is the same shape as `--key`, which
resolves *which node*, not *trust me* — and it is deliberately an enum, not free text. An enum claim
is falsifiable by any reader (`--approval-kind hold` on a prompt reading "ready to merge" is a
visible defect) and it is greppable in transcripts, so abuse can be measured. A free-text reason is a
field that can be filled with a rationalisation at zero cost, against the pressure of waiting an
unknown time for a human — and no reader can ever check it.

**A concrete false case for `credential`:** *"approve
the deploy so the new secret takes effect"* is not a credential ask, however it's phrased — it asks
the user to advance something (the deploy), which is exactly what an advancement approval is. A
credential ask asks the user to **supply** something the work cannot start without; it never asks
them to move work forward. `--approval-kind credential` on that prompt is the same visible defect as
`--approval-kind hold` on "ready to merge" above.

**A concrete false case for `checkpoint`:** *"the PR is paused waiting for you to approve the
merge"* is not a checkpoint — it is an advancement approval, and it waits. A checkpoint is
harness-initiated, external, and decision-free; approving a merge is a decision the user makes.
`--approval-kind checkpoint` on that prompt is the same visible defect as the two above.

## 4. Reconcile by channel

Reconciliation applies to items posted to the board; with no board nothing was posted and the terminal reply is acted on directly. It depends on **how** the user answered, not on the item type alone:

| The user answered... | Questions | Approvals |
|---|---|---|
| On the dashboard | `dashboard item consume --all` (or `--item "<id>"` when a sibling item is still open) | `dashboard item consume --all` (or `--item "<id>"` when a sibling item is still open) |
| In the terminal | `dashboard item answer --item "<id>" --response "$(cat "<tmpfile>")"` | `dashboard item approve --item "<id>"` |

**A terminal answer goes through a private temp file, never a shell string** — an answer routinely quotes code, and a backtick or `$var` in a double-quoted string mangles the command before `dashboard item answer` ever runs. Write the answer to `<tmpfile>` (`umask 077; mktemp`), then `dashboard item answer --item "<id>" --response "$(cat "<tmpfile>")"` — command substitution's *output* is not re-expanded, so the file's content stays literal — then `rm -f "<tmpfile>"`.

Rejection notes are read via `dashboard answers` (or `dashboard comments` for reviewer comments). **Reading never consumes** — reconcile separately with `dashboard item consume`. Each item's `→` line names the command. A comment is answered on the board first, then consumed, unless §6 exempts it from a reply.

**An answer you cannot place — read the prompt back, never ask the user to repeat it.** After a
compaction you may hold an item id and an answer like `1 - A` with no memory of what you asked.
`dashboard item show --item "<id>"` prints that item's type, state and prompt in any lifecycle
state, consumed included, and writes nothing. Asking the user to restate a question they have
already answered is a failure of this protocol, not a neutral clarification.

**It returns the prompt, never the answer — and that is what keeps `consume` honest.** The recovery
read is deliberately not a second answer-reading surface: at runtime the paths that stamp `readAt`
are `dashboard answers` and `dashboard comments`, and `dashboard item consume` refuses an item whose
`readAt` is still null. So the order is unchanged: read the answer with `dashboard answers`, then
consume it. `dashboard item show` only tells you what the question *was*. If a consume is refused
with *"Item's answer has not been marked read"*, the fix is to run `dashboard answers` — never to
reach for a wider `item show`, and never to read the answer out of the board database directly,
which stamps nothing and leaves the item unconsumable.

**It reads through an ended or closed session, and refuses a deleted one.** That is the whole point
— the agent that lost its question is usually the agent whose node has since finished — but deletion
is not finishing. A deleted session's items are gone, and handing their text back would be
undeletion rather than recovery, so `item show` exits 1 there, as it does for an id that matches
nothing. Both are ordinary non-zero exits with the reason on stderr; neither is a case to retry.

**Every verb in this section refuses rather than guesses when this session has more than one live leaf, or no live node anywhere** — with two exceptions: `dashboard item withdraw` with neither `--item` nor `--all` targets no session at all, so it invokes the backend bare instead of resolving one, and `dashboard item show`, which targets an item id rather than a session and so resolves no leaf at all. Every other invocation here resolves and can refuse this way: `dashboard answers`, `dashboard comments`, `dashboard item consume`, `dashboard item withdraw --item "<id>"`/`--all`, `dashboard item answer`, `dashboard item approve`, and `dashboard item reject` all name the ambiguous leaves and exit nonzero instead of silently acting on one of them — this is deliberate: a caller that guessed would reconcile the wrong node's ledger, not just the wrong one's ticket link. With `ai-workflow-app` reachable, a session that never ran `dashboard session enter` gets the same refusal, not a silent no-op: run `dashboard session enter` first. When `ai-workflow-app` does not resolve, these verbs no-op silently instead; a resolved `ai-workflow-app` that fails when called is a different case, and is loud — §1's CLI availability section covers both. Pass `--key <leaf-key>` (or `--session <internal id>`) to say which node the reconciliation is for.

## 5. Read the whole answer — it is multi-line

The wake message the mod starts a turn with, and `dashboard answers` output, are **multi-line**: only the first line carries the `[dashboard] item <id> (<type>):` marker — the user's answer (`response`) follows on that line *and every line after it*. An indented `↳` line after the answer names an item that this one references. On a comment, it is the item the user's comment is about. The last line of each item, beginning `→`, says what to do with it and names the command that consumes it. Read the whole thing. **Never `grep`, `tail`, `head`, or otherwise line-filter the wake message or `dashboard answers` output** — a marker-word filter (`grep '[dashboard] item'`, `tail -3`) silently drops the body of the answer. If you only see one line of a reply you expected to be longer, suspect your own read command first.

## 6. Consume what you read — universal

**No exceptions.** On ANY wake with `[dashboard] item <id> ...`, and on any read of a released item with `dashboard answers` or `dashboard comments`, act on the item, then consume it (`dashboard item consume --item "<id>"` or `--all`) BEFORE you go idle or stop. Every released item, in the wake and in both reads, ends with a `→` line naming the exact command for it. The wake mod does not re-deliver a released item, but an unconsumed one stays released on the board and in `dashboard answers`, and reads as unanswered. The Stop hook blocks a stop, as advice and only a bounded number of times, while it can see a released item that is unconsumed, and names each one. When it cannot read the board it does not block, so the rule is still yours. This applies everywhere a released item is handled — PR Lifecycle's two-way handlers and every other skill or hook that reacts to a dashboard item.

**A comment is answered on the board before it is consumed.** Never reply to a comment only in the terminal, and never consume a comment you have not answered on the board. The one exception is a comment that asks nothing and gives you nothing to act on, such as "thanks", which is consumed with no reply. The reply is posted on the node the comment was released on — `--session "<node id>"`, the same targeting `item consume` takes below — and carries `--answers "<comment id>"`. The terminal comes second, the same order a question follows (§2). Then consume the comment.

- A comment that is not exempt and raises a decision that earns a question (`skills/board/references/escalation-contract.md`) is answered by that question.
- Every other comment that is not exempt is answered by an info note (§8), posted every time: `dashboard item add --type info --answers "<comment id>" --session "<node id>" --prompt "$(cat "<tmpfile>")"`. Answer what the comment asked, or say what you did or will do about it.

With `ai-workflow-app` reachable, `item consume` refuses instead of guessing when this session has more than one live leaf — pass `--key <leaf-key>` (or `--session <internal id>`) naming the node the wake was for. A session with no live node anywhere gets the same refusal, not a silent no-op: run `dashboard session enter` first. When `ai-workflow-app` does not resolve, `item consume` no-ops silently instead; a resolved `ai-workflow-app` that fails when called is a different case, and is loud — §1's CLI availability section covers both.

## 7. Parking, and when not to park

A blocker you discovered and scoped is yours to work, not a handoff; if you are blocked and waiting on the user, the board must say so (post the blocking item) *before* you go quiet — an `active` node with nothing happening is a lie.

**A stop-gate block with no open item is an instruction to keep working, not to park.** When the
Stop hook blocks and names no pending dashboard item, nothing on the board is waiting on an answer,
so there is nothing the wake mod could wake you for right now. With an item open, the Stop gate
allows the stop, because the wake mod checks the board while the session is idle.

Carry on with the active plan instead. End the turn **only** if you can name a specific pending
thing and the event that will wake you — a teammate you have messaged who owes you a reply, a
background task that re-invokes you when it exits, or a monitor armed on a condition that can
actually occur. These are **not** wake paths: that the user might come back; that a teammate might
have something for you; or work you have finished
and want to be told what to do next — that last one is a `dashboard item add`, not a wait. If you
cannot name one, you have no wake path and you keep working. If what you need is the user, `dashboard item add` FIRST — the item is what makes the wait
real (FLOW-223). Being stuck on the workflow outside the story you are working is not needing the
user — write it to the process improvement notes and keep going; if you cannot finish what you were
asked, that is a blocker and escalates by the ordinary rules, as the stalled work, naming what
stalls (`skills/board/references/escalation-contract.md` §Workflow improvements are notes).

**A usage-limit checkpoint is a park, and parks go on the board.** When the harness injects a
`[Usage limit approaching. Checkpoint now: ...]` message, the session is about to pause with work
unfinished. This is not a decision for the user to make — it asks them to act (wait, or resume once
the limit resets), the same shape as the credential ask above — so it posts as an approval, not a
question: write what you were doing, the exact next step, and when the limit resets to `<tmpfile>`
(temp file, never a shell string — why: §2) — that prompt is the work in flight, the next step, and
the reset time, nothing else: a sentence naming whose call the resume is, or explaining what a usage
limit implies, is the padding `skills/board/references/escalation-contract.md` §Required question form forbids — then
`dashboard item add --type approval --approval-kind checkpoint --prompt "$(cat "<tmpfile>")"`,
then `rm -f "<tmpfile>"`, before you wind down. A session that goes quiet at a usage limit
with nothing on the board is indistinguishable from one that crashed (FLOW-223).

## 8. Info notes

An info note tells the user something worth keeping that needs nothing from them. It shows on the
board as unread until they mark it read, it never puts the session under "Needs me", and nothing
answers it — so nothing waits on it, and the agent that posted it never gets it back.

`dashboard item add --type info --prompt "$(cat "<tmpfile>")"` → prints
`{"itemId":"<id>","note":"<reminder>"}`.
Round-trip the prompt through a private temp file, the same as a question (§2). The first line is
the lede, capped at 200 characters, and the whole prompt is capped at 1500. There is no declaration
line, and `--recommend`, `--stalls`, `--why-mine`, `--defer` and `--approval-kind` are refused. The
id is not recorded in the node's open-items ledger: the wake check and the Stop hook's gate read a
non-empty ledger as "an answer can arrive", and a note never gets one. Posting a note is therefore
not a wait — never park on one (§7). To retract a note posted by mistake,
`dashboard item withdraw --item "<id>"`.

**Post a note on judgement, when something worth keeping would otherwise be lost in the thread** —
a call you made that the user would want to find later, a surprise in the codebase, a risk you
accepted. The bar: the user would want to know it later, it would otherwise live only in terminal
scrollback, and it is not a progress update. The session's phase and the PR already show progress;
a note that restates them is noise, and noise teaches the user to mark notes read unopened.

**A note never stands in for an approval.** Anything that asks the user to approve, merge, flip,
proceed or validate is an approval (`--type approval`), whatever surfaced the moment (a monitor
event, your own watcher, a re-read of the PR) and whether or not the step that prescribes it is
still in context. Posted as a note, it never reaches "Needs me" and nothing answers it, so the
work waits unseen, and the note does not count as the step done: withdraw it
(`dashboard item withdraw --item "<id>"`) and post the approval in its place. Every
`--type info` post returns a `note` field beside `itemId` saying so, and pr-monitor's
`CI_GREEN_ON_DRAFT` and `MERGE_READY` entries each carry a `→` line naming the PR Lifecycle handler
to run, which ends in that approval (FLOW-427).

**Three notes are prescribed, not judged.** The Renovate monitor's `all-done` session summary
(`skills/renovate-prs/references/monitor-runbook.md`, `event = "all-done"`) is posted every time
that event fires. The info-note reply that §6 prescribes for a board comment is posted every
time §6 calls for one. The report of a ticket the workflow meant to move and could not is posted
every time
`skills/workflow-guide/references/routing.md` §Cross-Phase Rule: The Workflow Moves Its Own Tickets
reports one. None of them waits on the bar above.

**Never post a note about a withdrawn question** — not that it was withdrawn, and not why, even
when a replacement question follows it. The withdrawal shows on the board, and that is all the user
wants about it.

A note never stands in for a question or an approval. If it needs an answer, it is a question (§2);
if it asks the user to act, it is an approval (§3).
