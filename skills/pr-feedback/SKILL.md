---
name: PR Feedback
description: Use when the user asks about PR review feedback, review comments, or wants to address reviewer feedback. Fetches unresolved inline review threads and the main review comments, evaluates each one, and implements or pushes back as appropriate.
---

# PR Feedback

## Overview

Fetch unresolved PR review comments, evaluate each one with technical rigor, then implement fixes or push back with reasoning.

**Core principle:** Verify before implementing. Push back when wrong. No performative agreement.

**Enter the dashboard session — mandatory first action, before anything else.** Re-enter the **ticket node** with phase `pr-feedback` — the same node PR Lifecycle re-entered, so a single PR stays one node — then, when there is a ticket, register the ticket link, since this enter may be the first dashboard action of the session when PR Feedback runs standalone. The URL is the ticket's canonical browse URL (the `webUrl` on the Jira response) — a handoff input from Team Dispatch / PR Lifecycle when run in a team; fetch it yourself with `getJiraIssue` first when run standalone. The block below enters the ticket node and registers its link; it resolves which node that is, so there is no block to choose. A ticket that genuinely produces several PRs then runs the second block **in addition**, never instead — it mints the PR-level child under the node the first block just entered, and registers no link of its own.

Invoke `workflow:board` for the protocol (session enter, items, reconcile).

```bash
# The ticket's own node, looked up rather than chosen: its key when it has one (a story under an
# epic root, or a -resumed replacement after a restart), empty when the ticket IS the root. A keyless
# enter or a --root link picked by hand lands on the EPIC's node when this is an epic story.
TICKET_NODE_KEY="$(dashboard session key --ticket "<TICKET-ID>")" || exit 1
TICKET_NODE=(--root); [ -n "$TICKET_NODE_KEY" ] && TICKET_NODE=(--key "$TICKET_NODE_KEY")
dashboard session enter --phase pr-feedback ${TICKET_NODE_KEY:+--key "$TICKET_NODE_KEY"}
dashboard link add --kind ticket --label "<TICKET-ID>" --url "<jira-url>" "${TICKET_NODE[@]}"
```

```bash
# In ADDITION to the block above — never instead of it. Only when this one ticket
# genuinely produces several PRs (a multi-repo story). Running it after the block above is what makes
# the lookup below unambiguous: the ticket node is already entered, so an empty result means one
# thing only — the ticket IS the dashboard root, which no --key can name (its key is null) — and
# the keyless form then parents this child to the root correctly. Do not add a `link add` here:
# the block above already registered the ticket link on the ticket node. This node is PR-level,
# not ticket-level — `link add --kind ticket --key <branch-name>` would wrongly attach it here,
# which is the one thing this comment forbids. A bare keyless attempt doesn't reach this node
# either — once it exists, keyless is refused rather than silently resolved to it.
# With no ticket the ticket's key IS the branch name, so this child takes --key
# "<branch-name>-<repo-name>" instead: the suffix keeps it from ever equalling the ticket key.
TICKET_NODE_KEY="$(dashboard session key --ticket "<TICKET-ID>")" || exit 1
dashboard session enter --phase pr-feedback --key "<branch-name>" ${TICKET_NODE_KEY:+--parent-key "$TICKET_NODE_KEY"}
```

`link add` is idempotent per node on `(kind, url)`, so it's a no-op when an earlier skill already registered the same link. The first block resolves the ticket's keying from this session's registry — an empty lookup is the root (see `skills/board/references/dashboard-protocol.md` §1, The ticket node key). The branch-keyed child from the Additional block is a PR-level node, not a ticket-level one (out of scope for the ticket link per the design doc) — never attach `link add --kind ticket` to it. Run the `enter` and, when there is a ticket, the `link add` on every run without exception — the resolved target is correct whether or not a PR-level child already exists, so there is nothing left to skip. (If the `dashboard` CLI isn't installed the command no-ops on its own — run it regardless; never skip it on the assumption the dashboard is unavailable.) With no ticket, skip `link add`; the lookup still resolves the node. (protocol: `skills/board/references/dashboard-protocol.md`)

## Fetching Comments

Fetch **unresolved inline review threads** using GitHub's GraphQL API:

```bash
gh api graphql -f query='
  query($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100) {
          nodes {
            isResolved
            path
            line
            comments(first: 50) {
              nodes {
                author { login }
                body
                createdAt
              }
            }
          }
        }
      }
    }
  }
' -F owner='<owner>' -F repo='<repo>' -F pr='<pr-number>'
```

Only process threads where `isResolved` is `false`.

**Why GraphQL:** The REST endpoint returns all comments without resolution status. GraphQL's `reviewThreads` includes `isResolved`.

**Also fetch the main review comments** — a reviewer's comment is not always inline. Two objects
carry one:

```bash
# Review bodies — the summary typed into the "Review changes" box. This query filters nothing, so
# every invocation returns the reviews you already processed alongside any new one. Skip:
#   - An EMPTY body. There is nothing to read, whatever else the submission carried — inline
#     comments, a bare approval.
#   - A PENDING review. That is an unsubmitted draft, and GitHub returns a draft to its own
#     author — which here is you, because the agent and the human share one GitHub account
#     (below). So this fetch does return your own draft, and nobody has delivered it as
#     feedback. Read it and you answer a review the reviewer is still writing.
#   - A body you have already processed. Nothing in this response excludes one for you, and the
#     wake does not either on its own: `new-main-comments` fires only on ids the previous poll had
#     not seen, so it carries what is new while this fetch carries everything. What it does not
#     narrow is the author — this arm applies no author test, so a newly submitted non-empty body
#     wakes you whoever wrote it, and a bot's review body wakes you exactly as a human's does.
gh api graphql --paginate -f query='
  query($owner: String!, $repo: String!, $pr: Int!, $endCursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviews(first: 100, after: $endCursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id state body author { login } }
        }
      }
    }
  }
' -F owner='<owner>' -F repo='<repo>' -F pr='<pr-number>'

# Top-level PR conversation comments — the whole conversation history, every time you run it.
# This fetch filters nothing, so exclude by hand what the monitor's wakes exclude for you. Three
# things, not two:
#   - Comments you have already processed. The wakes fire only on ids the previous poll had not
#     seen, so between them they carry what is new while this fetch carries everything — but a
#     conversation comment splits by author: a non-bot's wakes you as `new-main-comments`, a
#     bot's substantive one as `NEW_BOT_COMMENTS` (and a bot's rewrite of one it already posted as
#     `bot-comments-edited`). A bot comment here with no `new-main-comments` behind it is therefore
#     not evidence you have seen it before. Nor does the monitor have processed-or-not state to
#     offer: `PrViewResult` projects three fields from this same `--json comments` output — `id`,
#     `author`, `body` — where the inline-thread fetch above has `isResolved` and this skill keys on
#     it. What you have instead is the count and author list in each wake's own detail line, which
#     says how many are new and from whom, not which ones. Skip this and every invocation after the
#     first re-processes the whole history as fresh feedback.
#   - Comments this session posted itself. The agent and the human share one GitHub account, so
#     a comment you posted and that human reviewer's carry the same author. In the turn that
#     posts one you have its id — the `node_id` you recorded with `pr-monitor --ack-comment`
#     (§Record a comment the monitor would otherwise wake you on). A recorded id suppresses that
#     comment's own wake, under two limits. Ordering: a poll reads the PR's state before it reads
#     the recorded ids, so a poll whose fetch lands after the comment posts but whose id-read
#     lands before `--ack-comment` writes the id surfaces that comment once anyway, and no later
#     `--ack-comment` un-surfaces it (§Record a comment the monitor would otherwise wake you on,
#     which states this for a thread-opening inline comment; the same read order produces it
#     here). Storage: the store keeps the most recent `MAX_SELF_COMMENT_IDS` per PR and evicts the
#     oldest past that. And no flag prints the stored ids back, so on a later invocation you
#     cannot match them against this fetch by hand.
#     A comment's `body` can carry a `claude says:` first line (§Attribution), and that is not
#     sufficient on its own — that section omits the prefix when the reply answers a bot, so an
#     unprefixed comment can still be yours.
#   - CodeRabbit's rate-limit and pause banners. They report the reviewer's own state rather than
#     feedback to act on, and the PR Lifecycle skill owns the response to them.
# A bot's substantive comment stays in scope — §Automated tool accuracy below says how to read it.
gh pr view "<pr-number>" --repo "<owner/repo>" --json comments
```

Process these exactly as you process an inline thread — §Evaluating Comments and §Processing
Feedback apply unchanged, including the ledger routing. The monitor wakes you on them as
`new-main-comments` (a non-empty review body on a submitted review — any author, bot or human, but
never a PENDING draft — or a conversation comment from a non-bot login), `NEW_BOT_COMMENTS` (a
conversation comment from a bot), and `bot-comments-edited` (a bot rewrote a conversation comment it
had already posted — judge its **current** body; an id you processed before is not processed when
its body has changed). Neither wake carries CodeRabbit's rate-limit or pause banner:
those are read as a single status instead, and
`CODERABBIT_RATE_LIMITED` / `CODERABBIT_PAUSED` fire only when that status *changes*. A rate-limit
reading also wins over a pause, so a pause banner posted while a rate-limit banner still stands
changes nothing and produces no event at all.

## Evaluating Comments

### From the user
- **Trusted** — implement after understanding
- **Still ask** if scope is unclear
- **Skip to action** — no performative agreement

### From external reviewers (team members, bots like CodeRabbit)

**BEFORE implementing, verify each comment:**
1. Is it technically correct for THIS codebase?
2. Would it break existing functionality?
3. Is there a reason for the current implementation?
4. Does the reviewer understand the full context?

**If suggestion seems wrong:** Push back with technical reasoning via a reply in the PR comment thread.

**If it conflicts with the user's prior decisions:** Ask the user before making changes.

**If it's from an automated tool (CodeRabbit, etc.):** Be especially skeptical. These often lack context and suggest changes that are technically correct in isolation but wrong for the codebase.

### Automated tool accuracy (CodeRabbit, etc.)

**Never agree with an automated suggestion on first pass.** Always:
1. Read the actual code the suggestion references
2. Check if the suggestion conflicts with the user's stated intent or codebase conventions
3. Verify the suggestion is correct in context, not just in isolation

If the user has already expressed a preference during this session (e.g., "use hard failures, not silent fallbacks"), and an automated tool suggests the opposite — push back on the tool, not the user's decision.

Common automated tool errors:
- Suggesting silent fallbacks when the user wants hard failures
- Flagging established codebase patterns as issues (e.g., hardcoded ARNs in SST)
- Recommending abstractions for one-time operations
- Over-validation — defensive checks at internal layers, or re-validating an invariant already enforced at the boundary. Decline these per the **Boundary Philosophy** in `skills/code-review/references/review-rules.md`: validation belongs at external boundaries only, one invariant at one layer, and test-only null-tolerance is valid. The disposition is a reasoned decline on the thread, not a new guard.

**Reproduce before you accept *or* dismiss.** "Never agree on first pass" cuts both ways — don't reflexively reject either. The test is reproduction, not a second opinion: run the claim down to the actual code/state on both sides and diff. If the bot claims a bug, reproduce the bug (or prove it can't happen here). If you accept a bot's *fix*, reproduce that applying it doesn't regress anything — run the relevant gate/path before and after. A bot finding confirmed only by "that sounds right" is not confirmed; two reasoners agreeing on a third-party input is not validation. When you flag one instance of a class, sweep the whole file for every occurrence rather than fixing the single line the bot pointed at.

## Processing Feedback

```
FOR each unresolved comment:
  1. READ the full thread
  2. UNDERSTAND what's being asked
  3. VERIFY against the codebase
  4. DECIDE: implement, push back, or clarify
  5. If implementing or pushing back: OPEN the finding on the ledger
  6. ACT on the decision
  7. DISPOSE the finding to match the outcome
```

**If any item is unclear:** STOP. Ask for clarification before implementing anything. Don't implement what you understand and ask about the rest — items may be related.

**Route each comment through the ledger** (required when the ledger is present; no-ops only if the `review-ledger` CLI is absent) — the same obligation `skills/team-dispatch/SKILL.md` step 20 binds for the senior-review path, applied here to PR-feedback comments, and the same ledger-currency precondition `skills/code-review/references/checklist.md` §The re-arming predicate states for that path (cite it, don't restate the reasoning: commit, then dispose, never in between). A comment you decide to implement *or* push back on gets `review-ledger finding open --ticket "<TICKET-ID>" --file "<path>" --symbol "<symbol-or-quoted-literal>" --summary "<summary>" --origin "<user|human|coderabbit>"` before you act — `finding status` refuses an id that was never opened (exit 5), so both dispositions below need the id to already exist. Stamp `--origin` to match who raised it: `user` for the user, `human` for a team member or other external reviewer, `coderabbit` for an automated tool. When the fix lands: `review-ledger finding status --ticket "<TICKET-ID>" --id "<id>" --status fixed --fix-commit "<sha>"` (step 20's ledger-routing form in `skills/team-dispatch/SKILL.md`). When you push back instead: `review-ledger finding status --ticket "<TICKET-ID>" --id "<id>" --status withdrawn --reason "<why>"` — the same verb and the same reason obligation the checklist states for a senior's declined finding, applied here to a declined comment: state the reasoning in `--reason`, not only in the thread reply.

**Implementation order:**
1. Blocking issues (breaks, security)
2. Simple fixes (typos, imports)
3. Complex fixes (refactoring, logic)

Test each fix individually. Verify no regressions.

**A round that declines everything is a ready signal.** When a round ends with every remaining
finding pushed back on in its thread and no commit made, no bot will re-review — nothing was
pushed — so no wake will ever say the bots are done. Hand back to PR Lifecycle's **Bots satisfied**
check (`skills/pr-lifecycle/SKILL.md` step 9) as case (b) rather than waiting for a wake. A bot
all-clear that arrives on its own — "No actionable comments", "no issues" — carries
no findings: record nothing on the ledger for it and hand back to the same check as case (a).

## Responding to Comments

**When feedback is correct:**
```
✅ Just fix it — the commit is the response
✅ "Fixed. [Brief description]" if clarification helps
```

**When feedback is wrong:**
```
✅ Reply to the PR comment thread explaining why
✅ Use technical reasoning, reference working code/tests
✅ Ask specific questions if you're not sure
```

**NEVER say:**
- "You're absolutely right!"
- "Great point!" / "Excellent feedback!"
- "Thanks for catching that!"
- Any gratitude expression

Actions speak. The code shows you heard the feedback.

**Never add a code comment that acknowledges, echoes, or paraphrases review feedback.** If a reviewer says "always check the auth," the fix is the auth check — not a `// Always checking the auth` beside it. The commit is the response. Comments explain non-obvious logic to future readers; they do not record that a review happened. This is the same class as the narration rule in `skills/code-review/references/review-rules.md` §Code Quality — a comment that exists for a reason other than the next reader.

### Attribution

**When replying to human reviewers,** prefix the response with `claude says:` on the first line, followed by the actual response. This tells the reviewer they're reading an AI-generated reply, not the developer's own words.

**When replying to automated tools** (CodeRabbit, Dependabot, github-actions, or any author whose login ends in `[bot]`), do NOT add the prefix. Bot-to-bot replies don't need attribution.

**Examples:**

Replying to a human reviewer:
```
claude says: Fixed. The null check was missing because the upstream type guarantees non-null, but I've added it for defensive safety.
```

Replying to a human reviewer (push back):
```
claude says: This is intentional — the hardcoded value matches the SST resource ARN pattern used throughout the project. See `infra/storage.ts` for the convention.
```

Replying to CodeRabbit:
```
This is intentional — the function is called from the event handler in `src/handlers/process.ts`.
```

**A main review comment the agent posts carries the same prefix as an inline reply** — `claude says:`
on the first line when the comment answers a human, no prefix when it answers a bot. The prefix
marks who wrote the text, so it does not depend on where the comment lands.

**Prefer an inline comment on the code that changed.** When a main review comment asks for something
and the answer is a specific diff, reply with an inline comment on that code rather than another
main comment: it lands where the reader is looking and it opens a thread that can be resolved. Use a
main comment only when the response genuinely has no single site — a decision about the PR as a
whole, or an answer spanning several files.

**YAGNI check:** If a reviewer suggests adding features or "implementing properly," check if the code is actually used. If unused, push back: "This isn't called anywhere. Remove it (YAGNI)?" The bar is the one the review applies: `skills/workflow-guide/keep-it-simple.md`.

### Record a comment the monitor would otherwise wake you on

**A reply into an existing review thread lands inside it,** at whatever index it has reached —
never as a thread of its own. `toReviewThreads` reads only each thread's first comment
(`comments(first: 1)`), so a reply landing at index 1+ is invisible to it: there is nothing to
suppress, and nothing to do.

**A comment that does not reply to an existing thread opens its own,** with that comment as the
thread's first comment. The monitor cannot tell this apart from a reviewer's new finding by author —
the human user and the automation share one GitHub account — so it would wake the lead to handle its
own words. Whether a comment is suppressible is a property of which act produced it, not of how
often either act happens: a thread you opened is suppressible; a reply into someone else's thread is
never observed in the first place, so it would need no suppressing even if it were common.
`--ack-comment` exists for the thread-opening case. Post the comment, then record the id GitHub
returns on the same turn:

```bash
gh api "repos/<owner/repo>/pulls/<pr-number>/comments" \
  -f body="<comment body>" \
  -f commit_id="$(gh pr view "<pr-number>" --repo "<owner/repo>" --json headRefOid -q .headRefOid)" \
  -f path="<file-path>" \
  -F line="<line-number>" \
  -f side=RIGHT

# The response carries `node_id` — that is the value to record.
pr-monitor --ack-comment "<node_id-from-response>" --pr "<pr-number>" --repo "<owner/repo>"
```

It is idempotent per id, it records nothing else, and it never suppresses a thread anyone else
opened — including one opened from the user's own account. A poll cycle reads the PR's state before
it reads which ids this session has recorded; a poll whose fetch lands after the comment posts but
whose id-read lands before `--ack-comment` records it can surface that one comment as a false
`NEW_THREADS` once, and no later `--ack-comment` call retroactively un-surfaces it — the ordering
determines this outright, not how often the window is hit.

**A top-level comment you post is recorded the same way.** Now that the monitor observes main review
comments, a conversation comment the agent posts would wake the lead on its own words for exactly
the reason an agent-opened inline thread would — the shared GitHub account — so record its id too.
The REST response's `node_id` is byte-identical to the id GraphQL returns for the same comment, so
`--ack-comment` needs nothing new:

```bash
gh api "repos/<owner/repo>/issues/<pr-number>/comments" -f body="<comment body>"

# The response carries `node_id` — that is the value to record.
pr-monitor --ack-comment "<node_id-from-response>" --pr "<pr-number>" --repo "<owner/repo>"
```

A **review body** needs no recording step today, because nothing in this workflow submits a review —
the agent posts main comments as conversation comments. That is a fact about the current
instructions, not a property of the mechanism: `--ack-comment` validates no id shape, and
`compareStates` checks recorded ids against every `mainComments` entry, including ones sourced from
a review body. So if anything here ever does submit a review with a body, record its `PRR_` id the
same way and it will be suppressed the same way. The same poll-ordering window described above
applies here unchanged.

## After All Comments Are Addressed (standalone mode)

When you are running this skill on your own — no team, no senior reviewer — commit, then record `git rev-parse HEAD` as `<approved-sha>` — report it the way step 2's Block A reports `<pre-rebase-sha>`, since it is the same sha that block goes on to capture as its own `PRE_SQUASH_SHA` (a variable local to that block, not visible here). Then run `skills/pr-lifecycle/SKILL.md` step 2's Block A then Block B (squash what is unpushed into one commit, rebase onto `origin/main`, never merge `main` in). Run step 2's equivalence check too, using that `<approved-sha>` — there is no senior to approve one in standalone mode, so the commit this push started from stands in for it. Equal → push per that file's §Force-Pushing the Team's Own Branch. Unequal → there is no senior to send the interdiff to, so read it yourself: if it shows anything beyond what the rebase itself explains — a dropped hunk, an edit the conflict resolution introduced — stop and fix it before pushing. Run the repo's gates at the rebased HEAD either way, since there is no approved-SHA gate record to reuse. If a gate fails or the equivalence check is unequal in a way that needs a further fix before this push goes out, commit it as an ordinary commit — there is no dispatch here to relay it — then fold it per that file's step 2 fix path (immediately after committing the fix) before pushing. Do not wait for user confirmation before pushing. **In team mode this does not apply** — see "When Used Inside a Team" below: you commit, and the team lead pushes after senior re-review.

**Reconcile the write-ups before you push.** Re-read the PR description and the design doc against the fixes you just made, and correct whatever they falsified. Full rule: **Keep the PR's Written Artifacts True** in `skills/pr-lifecycle/SKILL.md`.

## When Used Inside a Team

When this skill is invoked during Team Dispatch's **PR Lifecycle** phase:
- Dispatch feedback to the team member who wrote the relevant code, following the finding form
  `agents/senior-engineer.md` §How You Work step 6 binds this dispatch to — forwarding a bot comment
  (CodeRabbit) or a human reviewer's comment verbatim does not exempt the dispatch from that form,
  and any code or wording the comment proposes is not passed on as the fix
- Don't send all feedback to all implementers — route to the one with context
- The implementer fixes and commits — never pushes; the senior role re-reviews the new commits (a fresh per-round spawn, not one persisting process — `skills/team-dispatch/SKILL.md` step 20's respawn procedure); then the team lead verifies and pushes. Push waits for senior review on every round, even after the branch is already pushed.
- Before the team lead pushes, reconcile the PR description and the design doc with the new commits — **Keep the PR's Written Artifacts True** in `skills/pr-lifecycle/SKILL.md`.
