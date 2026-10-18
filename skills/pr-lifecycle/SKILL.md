---
name: PR Lifecycle
description: After senior review, create a draft PR, watch the PR, handle review feedback and CI events, and wait for merge or user confirmation. Standalone — usable outside Team Dispatch.
---

# PR Lifecycle

## Checklist (mandatory, in order)

1. **Dashboard enter** (required when the board is present; silently no-ops only if the `dashboard` CLI is absent). One ticket + one PR = one node — do **not** mint a PR node for a single PR (see *Dashboard Session Nesting* in the Workflow Guide). Re-enter the **ticket node** with phase `pr` — the same node this work has been in since it started — then, when there is a ticket, register the ticket link, since this enter may be the first dashboard action of the session when PR Lifecycle runs standalone. The URL is the ticket's canonical browse URL (the `webUrl` on the Jira response) — a handoff input from Team Dispatch when run in a team; fetch it yourself with `getJiraIssue` first when run standalone (`skills/board/references/dashboard-protocol.md` §1). The first block below enters the ticket node and registers its link; it resolves which node that is, so there is no block to choose. A ticket that genuinely produces several PRs then runs the second block **in addition**, never instead — it mints the PR-level child under the node the first block just entered, and registers no link of its own.

   > Invoke `workflow:board` for the protocol (session enter, items, reconcile).

   ```bash
   # The ticket's own node, looked up rather than chosen: its key when it has one (a story under an
   # epic root, or a -resumed replacement after a restart), empty when the ticket IS the root. A keyless
   # enter or a --root link picked by hand lands on the EPIC's node when this is an epic story.
   TICKET_NODE_KEY="$(dashboard session key --ticket "<TICKET-ID>")" || exit 1
   TICKET_NODE=(--root); [ -n "$TICKET_NODE_KEY" ] && TICKET_NODE=(--key "$TICKET_NODE_KEY")
   dashboard session enter --phase pr ${TICKET_NODE_KEY:+--key "$TICKET_NODE_KEY"}
   dashboard link add --kind ticket --label "<TICKET-ID>" --url "<jira-url>" "${TICKET_NODE[@]}"
   ```

   ```bash
   # In ADDITION to the block above — never instead of it. Only when this one ticket
   # genuinely produces several PRs (a multi-repo story). Running it after the block above is what makes
   # the lookup below unambiguous: the ticket node is already entered, so an empty result means one
   # thing only — the ticket IS the dashboard root, which no --key can name (its key is null) — and
   # the keyless form then parents this child to the root correctly. Do not add a `link add` here:
   # the block above already registered the ticket link on the ticket node. This node is PR-level,
   # not ticket-level — `link add --kind ticket --key "<branch-name>"` would wrongly attach it here,
   # which is the one thing this comment forbids. A bare keyless attempt doesn't reach this node
   # either — once it exists, keyless is refused rather than silently resolved to it.
   # With no ticket the ticket's key IS the branch name, so this child takes --key
   # "<branch-name>-<repo-name>" instead: the suffix keeps it from ever equalling the ticket key.
   TICKET_NODE_KEY="$(dashboard session key --ticket "<TICKET-ID>")" || exit 1
   dashboard session enter --phase pr --key "<branch-name>" ${TICKET_NODE_KEY:+--parent-key "$TICKET_NODE_KEY"}
   ```

   A PR gets no node of its own; the ticket node advances to the `pr` phase. `link add` is idempotent per node on `(kind, url)`, so it's a no-op when Team Dispatch already registered the same link earlier in the session. The branch-keyed child from the Additional block is a PR-level node, not a ticket-level one (out of scope for the ticket link per the design doc) — never attach `link add --kind ticket` to it. Run the `enter` and, when there is a ticket, the `link add` on every run without exception — the resolved target is correct whether or not a PR-level child already exists, so there is nothing left to skip. With no ticket, skip `link add`; the lookup still resolves the node.

2. **Squash, rebase, verify the patch, then the final gate check — before every push.** Every push
   to the PR branch, the first and every later one, runs this step. Commits pile up freely while work
   is in progress, so the history is there to go back to; this step collapses them only at the moment
   of a push, into exactly one new commit, and replays the branch onto current `origin/main` so the PR
   is never pushed behind `main`. **The branch takes `main` only by rebasing onto it — never merge
   `main` into it:** a merge commit interleaves `main`'s changes with the ticket's own, and neither the
   equivalence check below nor a review can then tell which lines are the ticket's. The team lead never
   commits (`skills/team-dispatch/SKILL.md` step 17): dispatch the squash and rebase to the
   implementer, who runs, in the worktree, the block for the push being made.

   The first push turns the whole branch into one commit. Its subject is the PR title and its body is
   the What and Why sections of the PR body (step 4), so whatever the repository's squash setting
   reads at merge starts from the PR's own words. Draft the step 4 body before dispatching this and
   hand the implementer those two sections:

   ```bash
   git fetch origin main
   rc_fetch=$?
   if [ "$rc_fetch" -ne 0 ]; then
     echo "stop: git fetch origin main failed (rc_fetch=$rc_fetch)" >&2
     exit 1
   fi

   PRE_SQUASH_SHA="$(git rev-parse HEAD)"
   MERGE_BASE_SHA="$(git merge-base origin/main HEAD)"
   rc_merge_base=$?
   if [ "$rc_merge_base" -ne 0 ]; then
     echo "stop: git merge-base origin/main HEAD failed (rc_merge_base=$rc_merge_base)" >&2
     exit 1
   fi

   git reset --soft "$MERGE_BASE_SHA" && git commit   # subject: the PR title; body: the PR body's What and Why; apply any open commit-message note
   rc_squash=$?
   if [ "$rc_squash" -ne 0 ]; then
     echo "stop: git reset --soft && git commit failed (rc_squash=$rc_squash) — recover with: git reset --soft $PRE_SQUASH_SHA" >&2
     exit 1
   fi
   git rev-parse HEAD                                                    # report this as <pre-rebase-sha>
   git -c commit.cleanup=whitespace rebase origin/main
   # on conflict: resolve, then git -c commit.cleanup=whitespace rebase --continue
   ```

   Every later push turns only what the remote does not have yet into one commit —
   `chore: [<TICKET-ID>] <what this push changes>` (no `[<TICKET-ID>] ` with no ticket), or `fix:`
   when it fixes a real defect in the shipped change (`agents/implementer.md` §Commit Format).
   Pushed commits are never folded together: each push adds one. Both guards below are real control flow, not comments — run each bare, rc on
   the next line, no pipes, the same discipline **Force-Pushing the Team's Own Branch** below uses.
   This prep is two blocks, run in order — split so a conflict stop always names what to run next:

   **Block A — squash what's unpushed, then rebase the pushed history onto the new `origin/main`:**

   ```bash
   git fetch origin
   rc_fetch=$?

   rc_ancestor=""
   if [ "$rc_fetch" -eq 0 ]; then
     # Never reset onto a remote this branch does not fully contain — a non-zero exit here means
     # origin/<branch> holds a commit HEAD lacks, and the reset below would silently drop it.
     git merge-base --is-ancestor "origin/<branch>" HEAD
     rc_ancestor=$?
   fi

   if [ "$rc_fetch" -ne 0 ] || [ "$rc_ancestor" -ne 0 ]; then
     REBASE_HEAD_NAME_FILE="$(git rev-parse --git-path rebase-merge/head-name)"
     if [ ! -f "$REBASE_HEAD_NAME_FILE" ]; then
       REBASE_HEAD_NAME_FILE="$(git rev-parse --git-path rebase-apply/head-name)"
     fi

     if [ -f "$REBASE_HEAD_NAME_FILE" ]; then
       REBASE_HEAD_NAME="$(cat "$REBASE_HEAD_NAME_FILE")"
       if [ "$REBASE_HEAD_NAME" = "detached HEAD" ]; then
         echo "stop: origin/<branch> is not confirmed to be behind HEAD (rc_fetch=$rc_fetch rc_ancestor=$rc_ancestor) — a rebase is in progress with HEAD detached: this is Block A's own rebase, still mid-conflict. Resolve it, then run \`git -c commit.cleanup=whitespace rebase --continue\` as many times as it takes to finish; once it reports nothing left to rebase, run Block B below." >&2
       else
         echo "stop: origin/<branch> is not confirmed to be behind HEAD (rc_fetch=$rc_fetch rc_ancestor=$rc_ancestor) — a rebase is in progress with HEAD on $REBASE_HEAD_NAME: this is Block B's own rebase, still mid-conflict. Resolve it, then run \`git -c commit.cleanup=whitespace rebase --continue\` as many times as it takes to finish; once it reports nothing left to rebase, prep is done." >&2
       fi
       exit 1
     fi

     git symbolic-ref -q HEAD >/dev/null
     rc_on_branch=$?
     if [ "$rc_on_branch" -ne 0 ]; then
       echo "stop: origin/<branch> is not confirmed to be behind HEAD (rc_fetch=$rc_fetch rc_ancestor=$rc_ancestor) — no rebase is in progress and HEAD is detached: Block A already completed and Block B has not run yet. Run Block B below." >&2
       exit 1
     fi

     if [ "$rc_fetch" -ne 0 ]; then
       echo "stop: git fetch origin failed (rc_fetch=$rc_fetch) — this is a broken instrument, not a prep state: fix the remote or network, then re-run Block A" >&2
       exit 1
     fi

     BASE_REF="refs/push-base/<branch>"
     FROM_REF="refs/push-from/<branch>"
     git rev-parse --verify --quiet "$BASE_REF" >/dev/null
     rc_base_exists=$?
     if [ "$rc_base_exists" -gt 1 ]; then
       echo "stop: git rev-parse --verify --quiet $BASE_REF failed (rc_base_exists=$rc_base_exists)" >&2
       exit 1
     fi

     rc_base_ancestor=""
     rc_fresh=""
     if [ "$rc_base_exists" -eq 0 ]; then
       git merge-base --is-ancestor "$BASE_REF" HEAD
       rc_base_ancestor=$?
       if [ "$rc_base_ancestor" -gt 1 ]; then
         echo "stop: git merge-base --is-ancestor $BASE_REF HEAD failed (rc_base_ancestor=$rc_base_ancestor)" >&2
         exit 1
       fi
       if [ "$rc_base_ancestor" -eq 0 ]; then
         REMOTE_NOW="$(git rev-parse --verify --quiet "origin/<branch>")"
         rc_remote_now=$?
         FROM_SHA="$(git rev-parse --verify --quiet "$FROM_REF")"
         rc_from_sha=$?
         if [ "$rc_remote_now" -gt 1 ] || [ "$rc_from_sha" -gt 1 ]; then
           echo "stop: git rev-parse --verify --quiet origin/<branch> or $FROM_REF failed (rc_remote_now=$rc_remote_now rc_from_sha=$rc_from_sha)" >&2
           exit 1
         fi
         if [ "$rc_remote_now" -eq 0 ] && [ "$rc_from_sha" -eq 0 ] && [ "$REMOTE_NOW" = "$FROM_SHA" ]; then
           rc_fresh=0
         else
           rc_fresh=1
         fi
       fi
     fi

     if [ "$rc_base_exists" -eq 0 ] && [ "$rc_base_ancestor" -eq 0 ] && [ "$rc_fresh" -eq 0 ]; then
       echo "stop: origin/<branch> is not confirmed to be behind HEAD (rc_fetch=$rc_fetch rc_ancestor=$rc_ancestor) — this block already prepped HEAD for this push without pushing: HEAD was already squashed and rebased. Commit the fix as an ordinary commit instead of re-running this block — if origin/<branch> does not resolve yet, amend unconditionally (\`git commit --amend --no-edit\`); once it resolves, fold the fix in per step 2's fix path below, immediately after committing the fix." >&2
       exit 1
     fi

     if [ "$rc_ancestor" -ne 1 ]; then
       echo "stop: git merge-base --is-ancestor origin/<branch> HEAD failed (rc_ancestor=$rc_ancestor) — broken instrument, not a foreign-commit state" >&2
       exit 1
     fi

     PUSH_FROM="$(git rev-parse --verify --quiet "refs/push-from/<branch>")"
     rc_push_from=$?
     if [ "$rc_push_from" -gt 1 ]; then
       echo "stop: git rev-parse --verify --quiet refs/push-from/<branch> failed (rc_push_from=$rc_push_from) — broken instrument, not a foreign-commit state" >&2
       exit 1
     fi

     git log --oneline "origin/<branch>" --not HEAD $PUSH_FROM > "<foreign-commits-file>"
     rc_log=$?
     if [ "$rc_log" -ne 0 ] || [ ! -s "<foreign-commits-file>" ]; then
       echo "stop: git log --oneline origin/<branch> --not HEAD $PUSH_FROM failed or found nothing (rc_log=$rc_log) despite rc_ancestor=1 — broken instrument, not a foreign-commit state" >&2
       exit 1
     fi
     echo "stop: origin/<branch> is not confirmed to be behind HEAD (rc_fetch=$rc_fetch rc_ancestor=$rc_ancestor) — origin/<branch> holds commits reachable from neither HEAD nor refs/push-from/<branch>, named in <foreign-commits-file> (\`git log --oneline origin/<branch> --not HEAD $PUSH_FROM\`). Tell the team lead now; they post it per Board Triggers (Unconditional) below." >&2
     exit 1
   fi

   UNPUSHED_COUNT="$(git rev-list --count "origin/<branch>..HEAD")"
   rc_count=$?
   if [ "$rc_count" -ne 0 ]; then
     echo "stop: git rev-list --count failed (rc_count=$rc_count)" >&2
     exit 1
   fi

   if [ "$UNPUSHED_COUNT" -gt 0 ]; then
     PRE_SQUASH_SHA="$(git rev-parse HEAD)"
     git reset --soft "origin/<branch>" && git commit
     rc_squash=$?
     if [ "$rc_squash" -ne 0 ]; then
       echo "stop: git reset --soft && git commit failed (rc_squash=$rc_squash) — recover with: git reset --soft $PRE_SQUASH_SHA" >&2
       exit 1
     fi
   fi
   git rev-parse HEAD                                     # report this as <pre-rebase-sha>

   git update-ref "refs/push-from/<branch>" "origin/<branch>"
   rc_from=$?
   if [ "$rc_from" -ne 0 ]; then
     echo "stop: git update-ref refs/push-from/<branch> origin/<branch> failed (rc_from=$rc_from)" >&2
     exit 1
   fi

   git switch --detach "refs/push-from/<branch>"
   rc_detach=$?
   if [ "$rc_detach" -ne 0 ]; then
     echo "stop: git switch --detach refs/push-from/<branch> failed (rc_detach=$rc_detach)" >&2
     exit 1
   fi
   git -c commit.cleanup=whitespace rebase origin/main
   rc_rebase_base=$?
   if [ "$rc_rebase_base" -ne 0 ]; then
     echo "stop: git -c commit.cleanup=whitespace rebase origin/main failed (rc_rebase_base=$rc_rebase_base) — resolve, then run git -c commit.cleanup=whitespace rebase --continue as many times as it takes to finish; once it reports nothing left to rebase, run Block B below" >&2
     exit 1
   fi
   ```

   **Block B — record the base and replay this round's own commit onto it:**

   ```bash
   git update-ref "refs/push-base/<branch>" HEAD
   rc_base=$?
   if [ "$rc_base" -ne 0 ]; then
     echo "stop: git update-ref refs/push-base/<branch> HEAD failed (rc_base=$rc_base)" >&2
     exit 1
   fi

   git switch "<branch>"
   rc_switch=$?
   if [ "$rc_switch" -ne 0 ]; then
     echo "stop: git switch <branch> failed (rc_switch=$rc_switch)" >&2
     exit 1
   fi
   git -c commit.cleanup=whitespace rebase --onto "refs/push-base/<branch>" "refs/push-from/<branch>"
   rc_rebase_onto=$?
   if [ "$rc_rebase_onto" -ne 0 ]; then
     echo "stop: git -c commit.cleanup=whitespace rebase --onto refs/push-base/<branch> refs/push-from/<branch> failed (rc_rebase_onto=$rc_rebase_onto) — resolve, then run git -c commit.cleanup=whitespace rebase --continue as many times as it takes to finish; once it reports nothing left to rebase, prep is done" >&2
     exit 1
   fi
   ```

   Block A pins `origin/<branch>` to `refs/push-from/<branch>` immediately before detaching — that
   ref is what it actually replays from, so a foreign commit fetched between Block A and Block B
   cannot be silently absorbed as the recorded baseline. It
   then rebases that pinned commit — this branch's already-pushed history alone, nothing of this
   round's own on it — onto the new `origin/main`, in a detached `HEAD`; `<branch>` itself is not
   checked out and is untouched until Block B moves it. A conflict in Block A belongs to that
   already-pushed history meeting the new `main`, not to this round's own work; resolve it and
   continue the same way (`git -c commit.cleanup=whitespace rebase --continue`), as many times as it
   takes to finish, then run Block B. `refs/push-base/<branch>` then names exactly what survived that
   replay: whatever `main` has since absorbed drops out here the way `git rebase` always drops a
   commit that replays empty. Block B replays only what `<branch>` added on top of
   `refs/push-from/<branch>` — this round's own squashed commit — onto that recorded base; a conflict
   there is this round's own work meeting the rebased history, resolved the same way, and once it
   finishes, prep is done. Everything above `refs/push-base/<branch>` after this is this push's own
   content, whatever else `main` has absorbed in the meantime.

   **The freshness test**, used below by the fold, by Force-Pushing's pre-push guard, and inline by
   Block A's own already-prepped check above: `refs/push-base/<branch>` and `refs/push-from/<branch>`
   both resolve, `refs/push-base/<branch>` is an ancestor of HEAD, and `origin/<branch>` — resolved
   fresh at whichever site runs the test — string-equals `refs/push-from/<branch>`.

   **A `main` that moves again before this push completes is not re-prepped** — prep rebases onto
   `origin/main` once, and a `main` that moves after prep is taken on the next push's own Block A, or,
   if it conflicts with this push first, through the `MERGE_CONFLICT` handler (step 9 below), which
   runs step 2 — Block A then Block B — again.

   Every rebase invocation in this step sets `commit.cleanup=whitespace`, but `-c` only reaches the one
   `git` process it is given to. A conflicted rebase stops and that invocation exits, so resolving the
   conflict and continuing is a *new* `git` process — the flag must be repeated on it too:
   `git -c commit.cleanup=whitespace rebase --continue`. Without the repeated flag, that new process
   reconstructs the squash commit's message through the same path an interactive `git commit` does,
   whose default cleanup strips every line starting with `#` — including a markdown `## What` or
   `## Why` heading, not only the `# Conflicts:` scaffold git adds around it. `whitespace` mode leaves
   `#` lines alone, so resolving a conflict still requires deleting git's own injected comment block
   from the message by hand, the same as it always required deleting it from the diff.

   When `UNPUSHED_COUNT` is `0` — a push that only takes a moved `main` — the reset and commit above
   are skipped and the rebase runs alone. `PRE_SQUASH_SHA` is captured before the reset for exactly
   this failure: if `git commit` fails after `git reset --soft` already moved HEAD (an empty
   commit-message editor, a failing hook), HEAD is left at `origin/<branch>` with the squashed work
   gone from the branch tip — recoverable, not lost, because `git reset --soft` never touches the
   working tree or the index, both of which still hold the squashed work.

   Squashing before the rebase leaves the rebase one new commit to replay rather than a round's worth,
   so a conflict is resolved once. The implementer reports the `<pre-rebase-sha>`;
   **Force-Pushing the Team's Own Branch** below uses it to recognise the old remote commits
   as the team's own. Then the equivalence check — the replacement for `git diff "<approved-sha>..HEAD"`
   being empty (`skills/team-dispatch/SKILL.md` step 20), which a rebase onto moved `main` fails:

   ```bash
   git diff --binary "$(git merge-base origin/main "<approved-sha>")" "<approved-sha>" > "<approved-diff>"; rc_approved_diff=$?
   git diff --binary origin/main...HEAD > "<head-diff>"; rc_head_diff=$?
   grep -v -e '^index ' -e '^@@' "<approved-diff>" > "<approved-stripped>"
   grep -v -e '^index ' -e '^@@' "<head-diff>" > "<head-stripped>"
   cmp -s "<approved-stripped>" "<head-stripped>"; rc_equiv=$?
   diff -u "<approved-diff>" "<head-diff>" > "<interdiff>"; rc_interdiff=$?
   echo "rc_approved_diff=$rc_approved_diff"
   echo "rc_head_diff=$rc_head_diff"
   echo "rc_equiv=$rc_equiv"
   echo "rc_interdiff=$rc_interdiff"
   ```

   `cmp` runs on the diffs themselves with only the `index` lines (blob hashes, which differ because
   `<approved-diff>` and `<head-diff>` are cut against different base commits even when the change
   itself is identical) and `@@` hunk headers (line numbers, which shift for the same reason)
   stripped out — everything else, including whitespace and binary file contents (`--binary` on
   both `git diff` calls above, since without it a binary file's line just reads "Binary files …
   differ" and two different blobs would compare equal once the `index` line naming them is
   stripped), is compared byte for byte. `git patch-id`
   is not used here: it normalizes away leading and trailing whitespace on every line, so a conflict
   resolution that only reindents a line (moving `log(x)` out of an `if` block without changing its
   text) produces the same patch-id for two diffs that are not the same change, and the check would
   pass a dropped-context edit through unexamined. `rc_equiv` alone never settles this — the same
   discriminator **Force-Pushing the Team's Own Branch** below states for its own check 1 applies
   here with the polarity flipped: emptiness does not discriminate, because a `git diff` that failed
   against an unresolvable `<approved-sha>` writes nothing just as a genuinely empty diff would, and
   `cmp -s` on two empty stripped files exits 0 regardless of which one happened. A pass requires
   `rc_approved_diff` and `rc_head_diff` both `0` and `<approved-diff>`/`<head-diff>` both confirmed
   non-empty before `rc_equiv` means anything; any other combination is a broken instrument to
   repair, not the delta-round case below — a delta round assumes two real patches to compare, and a
   diff that failed or came back empty means that comparison was never established. Once both sides
   are confirmed non-empty, `rc_equiv` `0` → HEAD carries the approved change line for line, modulo
   only the diff bookkeeping stripped above; continue to the gate check. Non-zero → the rebase
   changed the patch — a conflict resolution, `main` moving the context lines the patch sits in, or a
   whitespace-significant edit — so the squashed commit's diff (`git diff origin/main...HEAD`)
   **and** the interdiff between `<approved-diff>` and `<head-diff>` go to the senior as a delta
   round (`skills/team-dispatch/SKILL.md` step 20) before anything is pushed. `rc_interdiff` above
   `1` is a broken instrument, not a clean interdiff — `diff -u` exits `1` on real differences, which
   is the expected case here, since `rc_equiv` already confirmed the two patches differ. A hunk
   present in `<approved-diff>` and absent from `<head-diff>` is dropped work the senior must account
   for: a conflict resolution that resolved by deleting an already-pushed change shows exactly this
   way, and check 1 below cannot see it — check 1 asks whether the remote holds anything absent from
   the `<pre-rebase-sha>` side, and a drop introduced by this push's own conflict resolution was
   never on the remote to be listed. That costs a review the change may not have needed; it never
   ships a change the review has not seen.
   The check runs on every push, because every push squashes and rebases.

   **Final gate verification — a coverage check, not a second run.** The squashed, rebased commit is
   a new SHA, but `check` matches a record by the tree its SHA names as well as by the SHA. When the
   rebase was a no-op the tree is identical, so the earlier green records still count, and each row
   names the SHA they came from in `reusedFrom`; a SHA that has runs of its own is judged by those
   alone. When the rebase changed the tree (normally because `main` moved), every gate reads
   `missing` and goes to its owner to run and record there — one fresh run, which a rebase onto
   moved `main` needs anyway.
   `gate-ledger check --ticket "<TICKET-ID>" --sha $(git rev-parse HEAD)` in the worktree. Exit 0 means every gate declared for the ticket has a green latest run at the SHA being pushed or, when that SHA has no run of its own, at one whose recorded tree is identical. Exit 3 names the gates that are `missing`, `failing` or `invalid`: a `missing` gate goes back to its declared `owner` to run and record at this SHA (the implementer for `owner: implementer` rows, the team lead itself for `owner: team-lead` rows), a `failing` one goes back to be fixed, and an `invalid` one (its recorded output is gone or no longer matches the digest recorded with it, per the row's `invalidReason`) goes back to its owner to re-run under `--condition inconsistent`. Exit 8's JSON names which of four causes applies — a cause is a reason for the exit, not the same unit as an `error` string, and there are only three of those strings: `error: "no gates declared for this ticket"` means nothing was ever declared for the ticket itself — go back to the team lead's kickoff declare (`skills/team-dispatch/SKILL.md` step 8). `error: "--manifest <path> does not exist"` means a `--manifest` override was given and that path is wrong — the ticket's own declared manifest, if any, was never consulted and is untouched; fix the flag, never re-declare on the strength of this message. `error: "<path> does not declare a usable \"gates\" array"` names whichever manifest actually resolved (the ticket's own, or the override) and by itself covers two of the four causes: a `detail` field alongside means that manifest is malformed, its absence means it parsed but the declared `gates` array is empty — both are repaired and re-declared, never silently worked around. **A manifest that exists and cannot be read is a different exit, 26, never 8** — the two prescribe opposite responses, declare versus do NOT declare and repair the file instead, so do not treat 26 as an exit-8 cause at all or route it to the kickoff declare. Do not re-run a gate that already has a green record at this SHA or one naming its tree; see `skills/team-dispatch/SKILL.md` step 13.

   **Re-running Block A before its own push completes deadlocks the ancestor guard above.** Once
   Blocks A and B have run, HEAD carries this push's own commit replayed onto
   `refs/push-base/<branch>` — `origin/<branch>` is no longer its ancestor, because the rebase gave it
   a new parent. A gate that fails on this HEAD, or a delta round that rejects the conflict resolution,
   sends you back to fix something — but running Block A again from the top trips the ancestor guard
   on data that was never actually lost, since nothing lands on `origin/<branch>` between the two runs;
   only the team lead pushes here.

   Commit the fix instead, not by re-running step 2 — a fix after this block has already prepped a
   push is always an ordinary commit, whether it is the first fix this round or a second one on top of
   the first. This applies only once `origin/<branch>` resolves and `refs/push-base/<branch>` exists;
   before the branch's first push, neither does — the first-push block above has already made the
   branch's only commit with nothing pushed yet, so a fix needed at that stage is unconditionally
   `git commit --amend --no-edit` (the same first-push exception `agents/implementer.md` §Commit
   Format states).

   Once `refs/push-base/<branch>` exists, fold everything sitting above it into one commit right after
   committing the fix — the implementer runs this, never the team lead, who does not commit
   (`skills/team-dispatch/SKILL.md` step 17):

   ```bash
   BASE_REF="refs/push-base/<branch>"
   FROM_REF="refs/push-from/<branch>"
   git rev-parse --verify --quiet "$BASE_REF" >/dev/null
   rc_base_exists=$?
   if [ "$rc_base_exists" -ne 0 ]; then
     echo "stop: $BASE_REF does not exist — step 2's Block A then Block B did not run for this push, or the ref was already cleaned up" >&2
     exit 1
   fi

   git merge-base --is-ancestor "$BASE_REF" HEAD
   rc_base_ancestor=$?
   if [ "$rc_base_ancestor" -ne 0 ]; then
     echo "stop: $BASE_REF is not an ancestor of HEAD (rc_base_ancestor=$rc_base_ancestor)" >&2
     exit 1
   fi

   REMOTE_NOW="$(git rev-parse --verify --quiet "origin/<branch>")"
   rc_remote_now=$?
   FROM_SHA="$(git rev-parse --verify --quiet "$FROM_REF")"
   rc_from_sha=$?
   if [ "$rc_remote_now" -gt 1 ] || [ "$rc_from_sha" -gt 1 ]; then
     echo "stop: git rev-parse --verify --quiet origin/<branch> or $FROM_REF failed (rc_remote_now=$rc_remote_now rc_from_sha=$rc_from_sha)" >&2
     exit 1
   fi
   if [ "$rc_remote_now" -ne 0 ] || [ "$rc_from_sha" -ne 0 ] || [ "$REMOTE_NOW" != "$FROM_SHA" ]; then
     echo "stop: $FROM_REF does not exist or origin/<branch> no longer matches it — re-run step 2's Block A then Block B" >&2
     exit 1
   fi

   ABOVE_BASE="$(git rev-list --count "$BASE_REF..HEAD")"
   rc_above=$?
   if [ "$rc_above" -ne 0 ]; then
     echo "stop: git rev-list --count failed (rc_above=$rc_above)" >&2
     exit 1
   fi

   if [ "$ABOVE_BASE" -ge 2 ]; then
     OLDEST="$(git rev-list --reverse "$BASE_REF..HEAD" | head -1)"
     git reset --soft "$BASE_REF" && git commit -C "$OLDEST"
     rc_fold=$?
     if [ "$rc_fold" -ne 0 ]; then
       echo "stop: git reset --soft && git commit -C failed (rc_fold=$rc_fold)" >&2
       exit 1
     fi
   fi
   ```

   `$ABOVE_BASE` of `0` means nothing sits above the base yet — a main-only push before any fix
   commit — so folding is skipped and there is nothing to push differently. `1` means exactly one
   commit already sits there, whether that is the ordinary push's own squash commit or, when the
   squash was skipped for a main-only prep, a single fix commit landed directly on the base — either
   way nothing to fold. `2` or more means multiple commits sit above the base — a squash plus one or
   more fixes, or two or more fix commits alone when the squash was skipped — and
   `git reset --soft "$BASE_REF" && git commit -C "$OLDEST"` collapses them into one commit, reusing the oldest one's
   author identity and message (`-C`) so the other commits' own messages never surface — not the
   committer, which every new commit sets fresh regardless of `-C`. `reset --soft` never touches the
   working tree or the index, so the folded commit has the exact tree `HEAD` already had — only how
   many commits it took to get there changes, never the content. The folded commit's message is
   literally the oldest commit's own — a main-only prep followed by fixes folds onto a fix commit's
   message rather than a squash commit's, since there is no squash commit to be the oldest — and that
   message may no longer describe everything the fold now carries; reword it with `git commit --amend`
   before handing back whenever it does not.

   **Force-Pushing the Team's Own Branch** below then verifies — a read-only check, not a second fold
   — that this left at most one commit above the base, and re-runs the freshness test, before push.

   After folding, re-run the equivalence check and the final gate check above against this folded
   HEAD — not the ancestor guard, the squash, or the rebase.

3. **Push the branch.** The first push has no remote branch to overwrite:
   ```bash
   git push -u origin "<branch>"
   ```
   Every later push follows step 2's rebase and goes out per **Force-Pushing the Team's Own Branch**
   below, whose pinned `--force-with-lease` form is correct whether or not `main` moved. A rejected
   first push may mean the remote branch moved — find out what moved it. When it is the team's own
   branch and the divergence is the workflow's own rebase, the remedy is **Force-Pushing the Team's
   Own Branch** below — force-pushing only when that section's checks say so — a board question only
   when that section's check 1 both exits `0` and finds a non-empty `<file>`. Any other rejection is a
   real problem to understand before pushing again.

4. **Create the draft PR:**
   ```bash
   umask 077 && mktemp                       # prints <tmpfile> — carry the literal path
   # write the body to <tmpfile>, then:
   # with no ticket the title is "<type>: <description>"
   PR_LIFECYCLE_ACTIVE=1 gh pr create --draft \
     --title "<type>: [<TICKET-ID>] <description>" \
     --body-file "<tmpfile>"
   rm -f "<tmpfile>"
   ```

   **The body goes through a private temp file, never a shell string** — a PR body is full of backticks and `$`, which a double-quoted bash string command-substitutes and expands. Same discipline as **Keep the PR's Written Artifacts True** below, which explains it in full: `umask 077; mktemp`, carry the literal path across Bash calls (shell variables do not survive between them), `--body-file`, then `rm -f`. Do not use a fixed path — concurrent PR sessions collide on a shared name, and a predictable path can be pre-seeded as a symlink.

   The body is a fixed template. **What** and **Why** are always there, and **Ticket** whenever there
   is a ticket; **Risk** is there only when it has something to say. With no ticket, the title has no
   `[<TICKET-ID>] ` and the body has no `## Ticket` section.

   ```markdown
   ## What

   <what the change does, in a few sentences>

   ## Why

   <the problem it solves>

   ## Risk

   <what a revert would not undo, how far a mistake would spread, any other risk>

   ## Ticket

   [<TICKET-ID>](<jira-browse-url>)
   ```

   **Risk says what this change cannot take back and how far a mistake in it would reach.** It has
   up to three parts, each its own paragraph:

   - `**One-way doors:**` and then what a revert of this PR would not undo: a schema migration,
     deleted or rewritten data, a contract other code or people depend on (an API, CLI output, a
     file format), a message sent outside the repo, a published release.
   - `**Blast radius:**` and then what breaks, and for whom, if this is wrong: one endpoint or every
     request, one user or every user, one service or everything that depends on it.
   - Any other risk the reviewer should weigh.

   Each part goes in only when it has something real to say. A part with nothing in it is left off,
   never written as "None", and when no part applies the whole section is left off. A later push
   that adds a one-way door or widens the blast radius adds it here, per **Keep the PR's Written
   Artifacts True** below.

   **No people's names in the title or body.** The PR is about the problem, the change, and the
   technology — never who requested it, reviewed it, or found the bug. No names, usernames, or handles
   (`skills/workflow-guide/references/no-people-names.md`).

   **Nothing outside that template goes in the body.** No **Out of scope** section. No **How to
   review** section — post it as a comment, same discipline as above. No filename of the implementation
   plan or the design doc: the PR reader does not have those files, so naming them tells them about
   a document they cannot open. And **never state the change as a contrast with something you did
   not do** — "we did X because we didn't do Y", "rather than Z", "this avoids W" — the reader never
   knew Y, Z or W was on the table, so the sentence describes a decision they cannot see and cannot
   check. **Its title and references must outlive the branch** — on a squash merge, which title
   becomes the commit subject is set by the repo's `squash_merge_commit_title` setting and whether
   the body survives at all by its `squash_merge_commit_message` setting, both of which you read
   rather than assuming either, at the same moment every commit either might name stops being an
   ancestor of `origin/main`, so quote content rather
   than citing a branch sha, anchor code references on symbols — or a quoted literal where no symbol
   exists — and give any measured figure its sample. The diff doesn't contain the title or body, so
   once the PR is open, check them too, against the same rules
   (`skills/workflow-guide/references/durable-references.md` §What to check). It is not a record of
   the work that produced the change — rounds of review that were fixed, defects found and corrected
   along the way, and what earlier passes missed are process history and belong in the process
   improvement notes, not on the PR. **Do NOT mark the PR as ready for review on your own
   initiative** — the user signals readiness by flipping it themselves in GitHub, or by approving
   the dashboard "flip to ready-for-review" item (you then run `gh pr ready` on their behalf — see
   the `CI_GREEN_ON_DRAFT` handler below). **Screenshots for UI changes:** if the PR includes
   visual/UI changes, put the frame showing what the change looks like now in the body: link a
   hosted copy of the frame per
   `skills/workflow-guide/references/notification-protocol.md` §Evidence files; when that section
   hosts nothing — notion unconfigured, or the file too large — say in the body that the frame is
   local instead of attaching its path, and otherwise follow that section's own failure handling. Do
   not Read the image to describe it; if the body needs words about what it shows, get them from an
   `artifact-viewer` (`skills/workflow-guide/references/routing.md` §Artifact Delegation).
   **The body is a living document, not a write-once artifact** — every later push
   re-checks it against what changed; see **Keep the PR's Written Artifacts True** below.

5. **Update process improvement notes.** If a notes file path was provided, add the PR URL to the `PR(s):` field. For multi-repo stories, append each PR URL as it's created.

6. **Provide links.** Generate the Graphite link: `https://app.graphite.com/github/pr/<owner>/<repo>/<pr-number>`. **Dashboard** (required when the board is present; no-ops only if the CLI is absent): register both links, targeting whichever node step 1 actually entered:
   ```bash
   # Single-PR case — the ticket's own node, looked up exactly as step 1 did (root when empty). A
   # literal --root here puts an epic story's PR links on the epic's node.
   TICKET_NODE_KEY="$(dashboard session key --ticket "<TICKET-ID>")" || exit 1
   TICKET_NODE=(--root); [ -n "$TICKET_NODE_KEY" ] && TICKET_NODE=(--key "$TICKET_NODE_KEY")
   dashboard link add --kind pr --label GitHub --url "<github-pr-url>" "${TICKET_NODE[@]}"
   dashboard link add --kind pr --label Graphite --url "<graphite-url>" "${TICKET_NODE[@]}"
   ```
   ```bash
   # Multi-PR case (step 1's Additional block also ran) — this PR's node is the branch-level child
   # that block minted, not the ticket root; --key names it the same way that enter did. With no
   # ticket that child's key is "<branch-name>-<repo-name>" (step 1): use it for --key in both.
   dashboard link add --kind pr --label GitHub --url "<github-pr-url>" --key "<branch-name>"
   dashboard link add --kind pr --label Graphite --url "<graphite-url>" --key "<branch-name>"
   ```

7. **Notification.** The GitHub and Graphite links registered in step 6 are the notification — the board carries them, and the session waits. Tell the user in-session that the PR is up for their bookmarking; do NOT call `open` to open browser tabs. Full rationale: `references/pr-lifecycle-reference.md` §Notification.

8. **Watch the PR (MANDATORY):**
   ```bash
   pr-monitor --pr "<pr-number>" --repo "<owner/repo>"
   ```
   Run it as an ordinary foreground `Bash` command: it registers the PR with this session and returns at once, leaving no process running. The wake mod's check (`mailbox check`) polls the watched PRs every 3 minutes while the session is idle (it polls as many PRs as fit its time budget, least recently polled first, and the rest wait for the next check), and a change (CI failure, new review threads, merge, or close) wakes you with a `[pr-monitor] changes detected on <owner/repo>#<pr>` entry. Registering again is harmless. **Initial notification timing:** the Graphite/GitHub links registered in step 6 are informational (let the user bookmark the PR). The "ready for review" notification with actionable context waits until CI passes (`MERGE_READY` below) — don't ping the user to look at a PR that's still running CI.

9. **Handle monitor events.** **Resolve a still-open "ready" item first if anything has invalidated it** — *before* handling the event below. Invalidation covers both directions in time, not just newly-arriving events, and splits into two kinds that take **different** actions:
   - **A new monitor event** — a CI failure, a new review thread, a merge conflict, or a freshly pushed commit needing re-review: post a new HOLD board item (see the **Board Triggers** section's HOLD rule) alongside the still-open ready item.
   - **An open question of your own whose answer could change this PR** — a review finding you are asking about, or a deferral-gate question, in **either** ordering (it doesn't have to arrive after the ready item; one that was already open when you posted it invalidates it just the same): withdraw the ready item now (`dashboard item withdraw --item "<id>"`, and `playtest stop --name "<branch-name>-<repo-name>"` when it is the flip-to-ready item) — never stack a HOLD beside an open question (`skills/board/references/dashboard-protocol.md` §3.1). The withdrawal is visible on the board; do not explain it in the question's prompt or in-session. Post a fresh ready item once the question resolves and the PR is still ready, with `--replaces "<id>"` naming the one you withdrew (`skills/board/references/dashboard-protocol.md` §2).

   **Consume a dashboard wake before acting on anything else — universal, no exceptions.** Full protocol: `skills/board/references/dashboard-protocol.md` §6. This applies everywhere a wake is handled below (the `CI_GREEN_ON_DRAFT` and `MERGE_READY` two-way handlers) and in every other skill or hook that reacts to a dashboard item. Then, per event type:

   - **NEW_THREADS:** Invoke the PR Feedback skill (`workflow:pr-feedback`) to evaluate the threads, then dispatch fixes to the implementer or push back on the PR thread as appropriate. Evaluate each comment on its merits (rationale: `references/pr-lifecycle-reference.md` §Event Handler Rationale).
   - **`new-main-comments`:** A main review comment arrived — the summary body of a submitted review,
     or a top-level comment on the PR conversation, rather than an inline thread. A review body
     reaches this event whoever wrote it: the author is not filtered, so a bot's review body arrives
     here rather than as `NEW_BOT_COMMENTS`. Invoke the PR Feedback skill (`workflow:pr-feedback`);
     it fetches both alongside the inline threads and routes each one the same way. Evaluate each on
     its merits, exactly as for `NEW_THREADS` — and where the author is a bot, with the
     bot-skepticism the PR Feedback skill's §Automated tool accuracy prescribes.
   - **NEW_BOT_COMMENTS:** A bot left a top-level comment on the PR conversation (CodeRabbit's
     findings summary is the usual one). Neither this event nor `new-main-comments` carries
     CodeRabbit's rate-limit or pause banner: those are read as a single status instead, and
     `CODERABBIT_RATE_LIMITED` / `CODERABBIT_PAUSED` fire only when that status *changes* — a
     rate-limit reading also wins over a pause, so a pause banner posted while a rate-limit banner
     still stands produces no event at all.
     A CodeRabbit reply refusing a re-request (`⚠️ Action not completed` with `Review rate limited`) is
     not feedback: it is a throttle the status reading never sees, so handle it as a fresh
     `CODERABBIT_RATE_LIMITED` occurrence rather than through PR Feedback. Take the wait from the
     reply's own `available in <N> minutes` (30-minute fallback), and pick the next command by that handler's step (3).
     Handle any other bot comment as
     `new-main-comments` above — the split between the two is who wrote the comment, not what you do
     about it: one conversation-comment fetch is partitioned by author, and `new-main-comments`
     additionally carries a submitted review's summary body — with the bot-skepticism the PR Feedback
     skill's §Automated tool accuracy prescribes.
   - **`bot-comments-edited`:** A bot rewrote a top-level comment it had already posted — CodeRabbit
     keeps one summary comment per PR and rewrites it on every review, so its verdict on a new push
     arrives here, never as `NEW_BOT_COMMENTS`. The detail names the count and authors, not which
     comments: re-read each named bot's top-level comments in full (`gh pr view "<pr-number>" --repo
     "<owner/repo>" --json comments`) and judge the **current** body. Findings → handle as
     `NEW_BOT_COMMENTS` above. A plain-language all-clear ("No actionable comments were generated in
     the recent review", "no issues") → the **Bots satisfied** check below. Neither — a status-only
     rewrite such as "Review skipped" or review-allowance text — needs nothing; the PR stays watched.
   - **Bots satisfied — request a human review.** Not a monitor event: a check you run in two
     places. **(a)** after reading an all-clear from any bot wake (`NEW_BOT_COMMENTS`,
     `bot-comments-edited`, or a bot-authored `new-main-comments`); **(b)** at the end of a PR
     Feedback round that declined every remaining finding and pushed no commit — nothing was
     pushed, so no bot will re-review and no wake is coming. Post the item only when all hold:
     the PR is out of draft; required CI is green on the current head — if it is not yet green,
     also run `gh pr checks "<pr-number>" --repo "<owner/repo>" --required
     --watch` via `Bash` with `run_in_background: true` and `timeout: 2147483647`: the monitor emits nothing when CI turns
     green on a PR that is out of draft (it emits only `CI_FAILURE`, or `MERGE_READY`, which needs
     an approval, a bot's included), so this watch's exit is the wake that re-runs this check; a
     failed check arrives as `CI_FAILURE` anyway, so on that exit there is nothing more to do; every
     bot reviewer that has commented on this PR has spoken since the last push and its latest word
     is an all-clear — a bot still showing findings, or not yet re-reviewed after the push, means
     wait (in case (b), a finding you pushed back on counts as spoken-to,
     not outstanding); every unresolved thread is one you answered with a pushback; no such item is
     already open for this head; and no merge item is already open for this PR — the race between an
     already-approved PR's CI going green (`MERGE_READY`) and the watch above exiting can land
     either order, and the merge item already covers getting a human review. It is an **advancement
     approval** — plain `--type approval`, never `--approval-kind` — so the deferred-queue flush and
     open-question precondition from `CI_GREEN_ON_DRAFT` above apply to it unchanged, with the same
     targeting. Same temp-file
     discipline: write `<rich markdown: TICKET-ID + PR link + head sha + which bots cleared it, or
     which findings were declined and the one-line reason for each + "bots are done — request a
     teammate's review">` to `<tmpfile>` — the ticket, the link, why it is ready, and the ask,
     nothing else — then `dashboard item add --type approval --prompt "$(cat "<tmpfile>")"`, then
     `rm -f "<tmpfile>"` → capture `<id>`. With no board there is no `<id>`: `item add` exits 3 and prints the approval, so ask it in the terminal, treat the user's terminal reply as the answer, and skip the id-based board steps (`consume`, `withdraw`, remembering the id). **Approved** means the user is getting a human review:
     `dashboard item consume --item "<id>"` and wait — the review arrives as
     `NEW_THREADS`, `new-main-comments`, or `MERGE_READY`. **Rejected** means something still needs
     doing first: read the note (`dashboard answers`), consume, dispatch the work, and the PR stays watched — the next all-clear or fully-declined round posts a **fresh** item. It is a
     "ready" item for step 9's invalidation rule and the HOLD update rule below.
   - **CI_FAILURE:** Dispatch to the implementer to investigate and fix.
   - **MERGE_CONFLICT:** Dispatch step 2 to the implementer — the squash of anything unpushed, then Block A and Block B's rebase onto the base branch, resolving conflicts and continuing with `git -c commit.cleanup=whitespace rebase --continue` as it goes for each block in turn — the implementer does **not** push. A conflict resolution changes the patch, so step 2's equivalence check sends the resolved diff to the senior as a delta round; step 2's final gate check follows, then the team lead pushes the rebased branch per **Force-Pushing the Team's Own Branch** below — force-pushing only when that section's checks say so — the rebase is what diverged it, and that push is an ordinary step here, a board question only when that section's check 1 both exits `0` and finds a non-empty `<file>` — reconciling the PR description and the design doc first, per **Keep the PR's Written Artifacts True** below. The PR stays watched across the push. If a delta round rejects the conflict resolution or a gate fails on this rebased HEAD, dispatch the fix to the implementer: a fix after step 2 has already prepped a push is always an ordinary commit (step 2 above), and the implementer folds it in there before handing back, so nothing needs relaying in the dispatch.
   - **CI_GREEN_ON_DRAFT:** All required CI checks passed while still in draft. **With a board, flush the deferred queue first:** target the ticket node explicitly if step 1's Additional block ran — that block mints a branch-keyed PR-level child, so the ticket node is no longer this session's sole leaf and a keyless call below resolves to the PR child instead, printing `[]` at exit 0, indistinguishable from a drained queue. Resolve the target immediately before each invocation below, never once into a shell variable — this loop waits for a human answer between rounds: `TICKET_NODE_KEY="$(dashboard session key --ticket "<TICKET-ID>")" || exit 1`. A non-empty key means this ticket has its own node (a story under an epic root, or a `-resumed` replacement) — pass `--key "$TICKET_NODE_KEY"` on every `list-deferred`, `drop-deferred` and `flush-deferred` call below. An empty key means the ticket IS the dashboard root (its key is null, and these verbs have no `--root`) — address it by internal id instead: `dashboard session status --json`, then the `localNodes[]` entry whose `parentId` is `null` (not `localActiveSessionId`, and not in `localLeafIds` — both name the PR child once it exists) names this node's `sessionId`; pass `--session "<that sessionId>"` instead. `dashboard item list-deferred` (`--key`/`--session` per the targeting above) — review what is queued, drop what the work itself already answered (`dashboard item drop-deferred --id "<id>" --reason "<what answered it>"`, same targeting), then `dashboard item flush-deferred --context "<pr url>"` (same targeting) if anything remains — it posts every queued question as its own item — wait for all of them to be answered and consumed, then confirm list-deferred reports an empty queue; a flush that failed part-way leaves the rest queued and says so — flush again. `approvalIsAllowed` (`tools/cli/src/dashboard/item.ts`) is scoped to the one node the approval item below actually targets, never to whichever node this drain happens to be running against: in the single-PR case the approval targets this same ticket node, so a remainder left behind here is not silently discarded, it refuses the next step outright (blocks any advancement approval while any question remains queued, exit 1). When step 1's Additional block ran, the approval below targets the PR child instead, so that mechanical refusal covers only the PR child's own remainder, not this ticket-node drain — nothing refuses a remainder left here in that branch; this loop, run to a genuinely empty `list-deferred`, is the only thing enforcing it. The PR is already pushed and CI is green at this point, so every flushed question points at real code. When step 1's Additional block ran, drain the PR child's own queue too — the branch-keyed PR child it mints is a separate node with its own deferred queue, and a `--defer` made while entered on it after that block ran queues there, not on the ticket node. Drain it with the same loop and `--key "<branch-name>"` (with no ticket, `--key "<branch-name>-<repo-name>"`) in place of the ticket-node targeting above; a remainder left there **is** caught by `approvalIsAllowed`, since the PR child is the node the approval item below targets. The single-PR case (no Additional block) has no such child; the ticket node's drain above is the whole flush, its own mechanical backstop applies, and nothing here changes for it. The flush comes **before** the flip-to-ready item, not beside it — post the flip-to-ready item only once both queues (or the one queue, single-PR case) are fully flushed, answered and consumed. **Precondition — check the board before posting** (`dashboard session status --json` — find the entry in `boardNodes[]` whose `id` equals `localActiveSessionId`, and read that entry's `openItemCounts.question`; trust that field over the local ledger, which is known to drift, FLOW-196. When step 1's Additional block ran, `localActiveSessionId` names the PR child, not the ticket node — the ticket node is no longer a leaf once the PR child is nested under it, so also find the ticket node's own entry in `boardNodes[]`: in the empty-key branch above, that is the same `<that sessionId>` the flush's targeting already resolved; in the non-empty-key branch, the flush's targeting resolves only `TICKET_NODE_KEY` and never an internal id, so find the ticket node instead as whichever `boardNodes[]` entry's `id` equals the PR child's own `parentId`, or whose `externalId` ends `:$TICKET_NODE_KEY` — then read its `openItemCounts.question` the same way; either node's non-zero count blocks the flip-to-ready item. The single-PR case has only the ticket node, and `localActiveSessionId` already names it — nothing here changes for it. If `localActiveSessionId` is null (0 or more than one live leaf — not the shape this step expects) or `openItemCounts` is absent because the installed backend predates REV-72, the match can't be made — fall back to the §3.1 prose rule as the only gate): any open question on either checked node blocks the flip-to-ready item, whether already posted or still in either deferred queue — a deferral-gate question, and any question about the advancing PR's own content, scope, or review findings, are always entangled with no judgement call; for any other open posted question, the entanglement judgement (`skills/board/references/dashboard-protocol.md` §3.1) decides whether you should have posted this approval in the first place — once a question is open, the guard blocks regardless of that judgement. This widens what counts as open; it does not move where the approval posts — the `item add --type approval` call below still resolves keylessly to the PR child once step 1's Additional block has run, correctly, since this is a PR-level decision and it is what lets `approvalIsAllowed` guard the child's own queue. Do **not** post the flip-to-ready item while any of those is open; the PR is not finished while its contents are still being decided. Post it as your next action once every entangled question resolves — the monitor's watermark does not need to re-fire for you to post it, so there is nothing to wait for beyond the answer(s). **Playtest — when the PR changes web UI, start one now** (§Playtest Link below); if an earlier flip-to-ready item for this PR is still open (kept beside a HOLD), withdraw it first and post the new item with `--replaces "<id>"` naming it, since the start replaces the playtest it linked to. **Dashboard — once no such question is open, post FIRST, board-primary:** round-trip the prompt through a private temp file, never a shell string — this prose is markdown full of backticks and `$`, which a double-quoted shell string mangles, and `dashboard item add` has no `--prompt-file`. Write `<rich markdown: TICKET-ID + PR link + the "Playtest: <url>" line when one is running + "CI green — flip to ready-for-review?">` to `<tmpfile>` (`umask 077; mktemp`) — that prompt is the ticket, the link, the playtest line, and the ask, nothing else: a sentence naming whose call the flip is, or explaining what green CI implies, is the padding `skills/board/references/escalation-contract.md` §Required question form forbids — then `dashboard item add --type approval --prompt "$(cat "<tmpfile>")"` — command substitution's *output* is not re-expanded, so a backtick or `$var` inside the file's content stays literal — then `rm -f "<tmpfile>"`. Capture `<id>` (two-way — never leave it open once the PR is ready; the open item is the sole notification channel). With no board there is no `<id>`: `item add` exits 3 and prints the approval, so ask it in the terminal, treat the user's terminal reply as the answer, and skip the id-based board steps (`consume`, `withdraw`, remembering the id); the playtest stops on that reply all the same. On `[dashboard] item <id> (approval): approved`: run `pr-monitor --ack-ready --pr "<pr-number>" --repo "<owner/repo>"` before `gh pr ready "<pr-number>" --repo "<owner/repo>"` in the same turn — an unspent ack suppresses the `READY_FOR_REVIEW` for your own flip, whichever check reads it, and only a check that began after the ack spends it (a check already running when the ack was recorded leaves it for the next one, whatever its reads see): that spending check seeing a draft means `gh pr ready` failed, so the ack is dropped and a later flip by the user still wakes you. An ack left with no `gh pr ready` behind it is dropped the same way by the next check that began after it, so it suppresses only a user flip read before that check saves — then `playtest stop --name "<branch-name>-<repo-name>"` and `dashboard item consume --item "<id>"`, and once `gh pr ready` has succeeded, move the ticket to review (§Moving the Ticket to Review below). On the user flipping the PR directly in GitHub instead of approving here: the monitor emits `READY_FOR_REVIEW` (or `MERGE_READY` if it's already approved and green) — withdraw this item and run `playtest stop --name "<branch-name>-<repo-name>"` when you handle that event. **If the user rejects this item with review comments** (read the note via `dashboard answers`): `playtest stop --name "<branch-name>-<repo-name>"`, consume it, dispatch the rework, and the PR stays watched — a new commit re-arms the `CI_GREEN_ON_DRAFT` watermark, so the monitor re-emits this event when the reworked head's CI goes green, at which point you post a **fresh** flip-to-ready item. Do not treat the first `CI_GREEN_ON_DRAFT` as one-time.
   - **READY_FOR_REVIEW:** The PR was taken out of draft directly in GitHub (not via the flip-to-ready gate) and isn't merge-ready yet. It fires only for a flip no unspent `pr-monitor --ack-ready` ack covers. If a `CI_GREEN_ON_DRAFT` flip-to-ready item for this PR is still open, it is now moot — `dashboard item withdraw --item "<id>"` and `playtest stop --name "<branch-name>-<repo-name>"`. Move the ticket to review (§Moving the Ticket to Review below). The PR stays watched (CodeRabbit reviews the now-ready PR; a later `MERGE_READY` carries it to the merge gate).
   - **Which ChangeTypes the lead can cause itself, and what suppresses each:**

     | ChangeType | Self-causable? | Disposition |
     |---|---|---|
     | `READY_FOR_REVIEW` | via `gh pr ready` | Suppressed by an unspent `--ack-ready` ack, which a later check spends; a flip with no unspent ack (the user in GitHub) still emits. |
     | `MERGED` | via `gh pr merge` | Not suppressed — terminal, drives Team Cleanup. |
     | `CLOSED` | only in theory | Out of class — no workflow step closes a PR. |
     | `MERGE_READY` | no | Content is someone else's verdict; the flip only makes it observable. |
     | `CI_FAILURE`, `CI_GREEN_ON_DRAFT` | no | The lead pushes the commit but doesn't know the outcome. |
     | `MERGE_CONFLICT` | no | Comes from the base moving, not from a lead push. |
     | `NEW_THREADS`, `new-main-comments` | covered | By `--ack-comment`. |
     | `NEW_BOT_COMMENTS`, `bot-comments-edited`, `CODERABBIT_RATE_LIMITED`, `CODERABBIT_PAUSED` | no | A bot's own output; the lead's re-request prompts it, the content is new. |
     | `monitor-wedged` | no | Reports the monitor's own fetch failures. |
   - **MERGE_READY:** All checks passed and approved. **This handler ends in a `--type approval` merge item, never an info note**, and it runs whenever you find the PR out of draft with at least one CI check reported, every reported check green or skipped and the check list read successfully, at least one reviewer's latest decision `APPROVED` and none `CHANGES_REQUESTED`, no unresolved threads with the thread list read successfully, and a clean merge state, whether this event, your own CI watch or a re-read of the PR told you so. A green draft goes to `CI_GREEN_ON_DRAFT` instead. A ready-to-merge note already on the board does not count: withdraw it (`dashboard item withdraw --item "<id>"`) and post the merge item below in its place. Move the ticket to review first if it is not there yet (§Moving the Ticket to Review below) — a draft flipped straight to approved-and-green reaches this event without a `READY_FOR_REVIEW`. **With a board, flush the deferred queue first, the same as `CI_GREEN_ON_DRAFT` above — including the same `--key`/`--session` targeting when step 1's Additional block ran:** `dashboard item list-deferred` (`--key`/`--session` per that targeting) — review what is queued, drop what the work itself already answered (`dashboard item drop-deferred --id "<id>" --reason "<what answered it>"`, same targeting), then `dashboard item flush-deferred --context "<pr url>"` (same targeting) if anything remains — it posts every queued question as its own item — wait for all of them to be answered and consumed, then confirm list-deferred reports an empty queue; a flush that failed part-way leaves the rest queued and says so — flush again. Same scoping caveat as `CI_GREEN_ON_DRAFT` above: `approvalIsAllowed` guards only the node the merge item below actually targets — this ticket-node drain's remainder is mechanically caught only in the single-PR case; when step 1's Additional block ran, the merge item targets the PR child instead, and this drain's remainder is enforced by the loop alone, not by any CLI guard. This is not redundant with `CI_GREEN_ON_DRAFT`'s flush — `READY_FOR_REVIEW` reaches this event without ever routing through `CI_GREEN_ON_DRAFT`, and the CLI's own deferred-queue guard (`skills/board/references/dashboard-protocol.md` §3.1, *the deferred-queue half of this guard*) refuses the merge item outright over any question left in the local queue; when the queue is genuinely empty, `list-deferred` prints `[]` and there is nothing further to do. When step 1's Additional block ran, drain the PR child's own queue too, the same way and with the same `--key "<branch-name>"` targeting (with no ticket, `--key "<branch-name>-<repo-name>"`) as `CI_GREEN_ON_DRAFT` above — a remainder left there **is** caught by `approvalIsAllowed`, since the PR child is the node the merge item below targets in that branch. The single-PR case has no such child and nothing here changes for it. The flush comes **before** the merge item, not beside it — post the merge item only once both queues (or the one queue, single-PR case) are fully flushed, answered and consumed. Look up approvers first, filtered to the CURRENT head (same stale-state class as the CodeRabbit re-request precondition above — a review is only meaningful against the commit it actually reviewed): `gh pr view "<pr-number>" --repo "<owner/repo>" --json reviews,headRefOid --jq '.headRefOid as $head | [.reviews[] | select(.state == "APPROVED" and .commit.oid == $head) | .author.login] | unique | join(", ")'`. Bot approvers are included deliberately — the merge gate lists every approver at the current head. **Precondition — check the board before posting** (`dashboard session status --json` — find the entry in `boardNodes[]` whose `id` equals `localActiveSessionId`, and read that entry's `openItemCounts.question`; trust that field over the local ledger, which is known to drift, FLOW-196 — this field reports posted questions only, never the deferred queue the flush step above already settled. When step 1's Additional block ran, `localActiveSessionId` names the PR child, not the ticket node — the same widening as `CI_GREEN_ON_DRAFT` above: also find the ticket node's own entry in `boardNodes[]` the same way `CI_GREEN_ON_DRAFT` derives it (the flush's own resolved id in the empty-key branch; otherwise whichever `boardNodes[]` entry's `id` equals the PR child's `parentId`, or whose `externalId` ends `:$TICKET_NODE_KEY`) and read its `openItemCounts.question`, and treat either node's non-zero count as blocking. The single-PR case has only the ticket node, and `localActiveSessionId` already names it — nothing here changes for it. If `localActiveSessionId` is null (0 or more than one live leaf — not the shape this step expects) or `openItemCounts` is absent because the installed backend predates REV-72, the match can't be made — fall back to the §3.1 prose rule as the only gate): any open posted question on either checked node blocks the merge item — a question about the advancing PR's own content, scope, or review findings is always entangled with no judgement call; for any other open posted question, the entanglement judgement (`skills/board/references/dashboard-protocol.md` §3.1) decides whether you should have posted this approval in the first place — once a question is open, the guard blocks regardless of that judgement. This widens what counts as open; it does not move where the approval posts — the merge item's `item add --type approval` call below still resolves keylessly to the PR child once step 1's Additional block has run, correctly, for the same reason as `CI_GREEN_ON_DRAFT` above. Do **not** post the merge item while one of those is open — post it once every entangled question resolves and the PR is still merge-ready. If a Bots-satisfied item for this PR is still open, `dashboard item withdraw --item "<id>"` — the merge item supersedes it. If the flip-to-ready item is still open (the user flipped the PR in GitHub and it was already approved and green), withdraw it the same way and run `playtest stop --name "<branch-name>-<repo-name>"`. **Dashboard — once no such question is open, post FIRST, board-primary:** same temp-file discipline as `CI_GREEN_ON_DRAFT`'s Dashboard step above — write `<rich markdown: TICKET-ID + PR link + approver names + "ready to merge — approved and all checks green">` to `<tmpfile>` — that prompt is the ticket, the link, the approver names and the ask, nothing else: a sentence naming whose call the merge is, or explaining what a bot-only approval implies, is the padding `skills/board/references/escalation-contract.md` §Required question form forbids — then `dashboard item add --type approval --prompt "$(cat "<tmpfile>")"`, then `rm -f "<tmpfile>"` → capture `<id>` (remember it for `MERGED`; the open item is the sole notification channel). With no board there is no `<id>`: `item add` exits 3 and prints the approval, so ask it in the terminal, treat the user's terminal reply as the answer, and skip the id-based board steps (`consume`, `withdraw`, remembering the id). On approval: merge with the repo's configured method (e.g. `gh pr merge "<pr-number>" --repo "<owner/repo>" --squash --delete-branch`) — append `--delete-branch`, or record why not for a repo where the branch must survive the merge. What that method produces is not a question for the user (`skills/board/references/escalation-contract.md` §The repo's merge method is not a question). Then `dashboard item consume --item "<id>"` — the HOLD rule still applies: if any issue surfaced since the ready signal, post a HOLD board item instead of merging. On the user merging directly in GitHub: the `MERGED` event below resolves the item.
   - **CODERABBIT_RATE_LIMITED:** CodeRabbit hit its rate limit. Carries a retry-after timestamp and an `occurrence` count. The count is information only and never changes what you do (rationale: `references/pr-lifecycle-reference.md` §Event Handler Rationale). **Never ask the user whether to skip, stop or keep re-requesting a CodeRabbit review, and never offer skipping it as an option: the answer is always to keep re-requesting.** On every occurrence, however many there have been: **(1)** Before ANY re-request: `gh pr view "<pr-number>" --repo "<owner/repo>" --json reviews,headRefOid` — an APPROVED review on the current head means the review already completed; skip the re-request entirely (3 live reproductions: FLOW-133, FLOW-149 ×2). **(2)** Wait until retry-after (schedule a wake-up). If "cooloff unknown", wait a fixed fallback of 30 minutes. **(3)** Re-request, regardless of any open flip-to-ready gate. Pick the command from the `reviews` that step (1) returned: when none is authored by `coderabbitai`, send `@coderabbitai full review`; otherwise send `@coderabbitai review`. This is the only rule that picks the command, and every other site defers to it. Post the picked command as a conversation comment and record the id it returns on the same turn, exactly as the PR Feedback skill's §Record a comment the monitor would otherwise wake you on prescribes: `gh api "repos/<owner/repo>/issues/<pr-number>/comments" -f body="<the command>"`, then `pr-monitor --ack-comment "<node_id-from-response>" --pr "<pr-number>" --repo "<owner/repo>"` with the `node_id` that response carries. Not `gh pr comment`: the REST post above is what hands you the `node_id` to record, and an unrecorded conversation comment wakes you on your own words as `new-main-comments` — the agent and the human share one GitHub account, so the author on your re-request is that human reviewer's own. **(4)** The PR stays watched. Only one re-request may be in flight. A duplicate `occurrence` (not advanced) = no new action. A throttle is never a reason to go quiet: until CodeRabbit's review lands on the head, a wake-up for the next re-request is always scheduled.
   - **CODERABBIT_PAUSED:** Before ANY re-request: `gh pr view "<pr-number>" --repo "<owner/repo>" --json reviews,headRefOid` — an APPROVED review on the current head means the review already completed; skip the re-request entirely (3 live reproductions: FLOW-133, FLOW-149 ×2). CodeRabbit auto-paused because commits were still flowing in (rationale: `references/pr-lifecycle-reference.md` §Event Handler Rationale). **If an open dashboard question or approval could change this PR:** do nothing now — re-request as part of handling that item's resolution. **Otherwise:** once the current work round has settled (no further commits expected), re-request. Either way, pick the command and post and record the re-request exactly as `CODERABBIT_RATE_LIMITED` step (3) above prescribes — never `gh pr comment`.
   - **`monitor-wedged`:** `MAX_CONSECUTIVE_UNKNOWN` consecutive checks could not poll the PR, and it is **no longer watched**. **Nothing about the PR changed** — this is news about the observer, not about the PR: the last known state is as of the last *successful* poll, not now. This is dominated by persistent failures, not transient ones — the `detail` carries the last failure's reason (a failed `gh` read, a poll that threw, or a poll too slow for its time slice); read it for the cause. Fix the cause first — and if the cause needs a credential this session does not have, that is a credential ask (**Board Triggers** below) — then register the PR again with `pr-monitor --pr "<pr-number>" --repo "<owner/repo>"`; **that registration IS this event's handling.** The saved baseline survives the unwatch, so the first check after registering re-derives everything missed. Do **not** add a `gh pr view` re-check on top of it.
   - **`could not be polled`** — not a PR event: a `[pr-monitor] <owner/repo>#<pr> could not be polled: the check failed to record its result: <error>` line, printed on every check until the cause is fixed. The check could not write its poll result to the session's pr-monitor store, so it cannot count failures or advance the baseline for that PR. **Nothing about the PR changed.** **The PR is still watched** — registering again would write to the same broken store. Fix the store (the directory the line's error names: disk full, wrong permissions) and the PR resumes on the next check.
   - **`dead-teammate`** — also delivered by the wake mod (`mailbox check`), not by a monitor: `[team] dead-teammate <name> …` means the named teammate has no running process (one whose process is running is never reported), so nothing it owes you (a report, a review verdict, a shutdown ack) can arrive. While its team still exists it is reported only once it joined at least 5 minutes ago (a grace period after spawn, so a normal startup delay isn't mistaken for death — not how long the process has been gone); a member of a team the harness has already removed is reported at once. Handle it per `skills/team-dispatch/references/team-dispatch-reference.md` §Error Handling.
   - **MERGED:** If a "PR ready to merge" or Bots-satisfied dashboard item is still open, resolve it: `dashboard item withdraw --item "<id>"` (the actual merge superseded it). Run `playtest stop --name "<branch-name>-<repo-name>"`. Then signal that cleanup should begin (invoke `workflow:team-cleanup` or notify the team lead).
   - **CLOSED:** Run `playtest stop --name "<branch-name>-<repo-name>"`, then notify the user — do NOT clean up automatically.

   **A non-terminal event leaves the PR watched** — there is nothing to relaunch. `MERGED` and `CLOSED` unwatch it automatically, and so does `monitor-wedged`; `pr-monitor --stop` unwatches it by hand. A session restart does not drop the registration, which is on disk. **Never fall back to `gh pr view` polling** — the saved baseline is what re-derives PR state, and a hand-rolled poll re-reads the PR on every turn to establish that nothing changed.

10. **Wait for user feedback (BLOCKING — this skill does not end until merge or user confirmation).** After the draft PR is opened, the team stays alive. Do NOT shut down any durable team member — implementers or the senior engineer — during this phase. Short-lived question-answering agents are not covered by that rule: a researcher, or one of the senior's own review sub-agents, still shuts down the moment its answer lands, per `skills/workflow-guide/references/routing.md` §Research Delegation. Do NOT invoke team-cleanup. Do NOT return control to the team-dispatch orchestrator. Fetch PR review comments (invoke `workflow:pr-feedback`, or fetch them directly: the GraphQL API for unresolved inline comments and for review bodies, and `gh pr view --json comments` for conversation comments); dispatch feedback to the implementer who wrote the code, not a fresh agent; implementers fix and commit — they do **NOT** push. If step 2 already squashed and rebased HEAD for this push before this feedback arrived — a gate failure or a delta round rejecting the conflict resolution, before the push completed — dispatch the fix to the implementer instead: a fix after prep is always an ordinary commit (step 2 above), and the implementer folds it in there before handing back. **Senior engineer re-reviews every round (mandatory)** — on an already-pushed PR, new commits get the same review gate as the first round; there is no "push now, review later." **The team lead pushes after the re-review passes** — dispatches step 2 to the implementer against the approved SHA, then runs step 2's equivalence check and final gate check, reconciles the PR description and the design doc with the new commits (**Keep the PR's Written Artifacts True** below), then pushes per **Force-Pushing the Team's Own Branch** below — force-pushing only when that section's checks say so — every round. **Batch fixes** — when multiple small issues are found in quick succession, the implementer batches them into a single commit; the team lead pushes once, after senior re-review, rather than pushing each fix individually (each push triggers a ~30-50 minute CI run). Repeat until the user is satisfied — this may take many rounds over an extended period. **CRITICAL:** wait for the user to explicitly indicate they're done (e.g., "looks good", "merged", "done") OR the PR Monitor detects a merge. Do NOT shut down the team proactively — that governs the durable members named above; a short-lived question-answering agent still shuts down when its answer lands. **The per-round senior respawn is not an exception to this** — each of this step's mandatory re-review rounds follows `skills/team-dispatch/SKILL.md` step 20's respawn procedure, and ending one round's senior when its verdict lands keeps the role filled for the next round, not the team going idle. Do NOT interpret a lull in activity as completion.

## Playtest Link

When the PR changes what a browser renders, the flip-to-ready item carries a link to the branch's
app, already running. Skip it when the PR changes no web UI, and when the repo puts up a per-PR
preview environment of its own (that environment is what the reviewer tries). Terminal and CLI
surfaces get no playtest.

**Start it** right before posting the flip-to-ready item, from the story's worktree (`<repo-name>` is the repo part of `<owner/repo>`, so a multi-repo story's playtests get distinct names):

```bash
playtest start --name "<branch-name>-<repo-name>" --dir "<worktree path>" --command "<launch command>"
```

- The launch command is yours to work out from the repo: its `package.json` scripts, its docs, the
  command its e2e suite uses. Put `{port}` where the app takes the port the link opens, and
  `{port:<label>}` for each further port it needs (a backend beside a frontend); the same ports are
  in `PLAYTEST_PORT` and `PLAYTEST_PORT_<LABEL>`. Never write a fixed port into it.
- When the app keeps data in a fixed path outside the worktree (a dev database, a state
  directory), point it at a directory under the worktree if it has a setting for that. If it has
  none, the playtest shares that data with other sessions; say so in the PR body.
- Pass `--path` when the change lives on a page other than `/`.
- Exit 0 prints JSON; its `url` goes in the item's prompt as a line of its own:
  `Playtest: <url>`.
- Exit 1 means the app did not come up; stderr has the reason and the log tail. That is a defect in
  the PR or in your launch command: fix it, and do not post the item without the link.

**Stop it** with `playtest stop --name "<branch-name>-<repo-name>"` everywhere that item ends: answered on the
board or in the terminal (before `consume`), and withdrawn (step 9's open-question case,
`READY_FOR_REVIEW`, the `MERGE_READY` route, the HOLD rule). `MERGED` and `CLOSED` stop it too, as
a backstop. A rejection's rework starts a fresh one at the next `CI_GREEN_ON_DRAFT`. When that
event fires with an earlier flip-to-ready item still open, withdraw the earlier item and post the
new one with `--replaces "<id>"`: the start replaces the playtest the earlier item linked to, and
no open item may carry the link of a stopped one. `stop` exits 0 when nothing is running, so call it without
checking first. Team Cleanup reaps any that are left.

## Moving the Ticket to Review

When the PR leaves draft for human review, move the ticket to a review status, when Jira is
configured and the project has one. Three events show it leaving draft, and each one runs this:
your own `gh pr ready` after the user approves the flip-to-ready item; `READY_FOR_REVIEW`, when the
user flipped it in GitHub; and `MERGE_READY`, which the monitor emits in place of
`READY_FOR_REVIEW` when the user flips a draft that is already approved and green. Running it again
is harmless — a ticket already in a review status, or already `done`, is left as it is — so a
multi-PR story moves on its first PR's flip and the later ones find it there. The procedure — why a
review status is matched by name within the `indeterminate` category, and what an ambiguous or
failed read does — is
`skills/workflow-guide/references/routing.md` §Cross-Phase Rule: The Workflow Moves Its Own Tickets.
No review status in the project means no transition and nothing to report. It never holds up the PR.

## Force-Pushing the Team's Own Branch

**A force-push to the branch the team created for its own ticket needs no user approval.** It is an
ordinary workflow action, not a bright line and not a board question — the workflow manufactures the
divergence itself by rebasing onto `origin/main` before every push (step 2). Asking is the failure
mode this section closes: the answer is mechanical, and it is yours to compute.

**Verify first — the rule is "verify, then push", not "push freely."** Both checks, every time,
against the branch you are about to overwrite. Run each bare, never through a pipe; check 1's output
goes to a file, check 2 reports through its exit status alone:

```bash
git fetch origin
rc_fetch=$?

# Resolve the remote only once the fetch itself succeeded — the guard, not the prose below,
# is what stops rc_resolve from ever being assigned against a stale (unrefreshed) remote.
REMOTE_SHA=""
if [ "$rc_fetch" -eq 0 ]; then
  # Resolve the remote once. --verify --quiet exits non-zero and prints NOTHING on an
  # unresolvable ref, instead of exiting 128 while echoing the ref string to stdout.
  REMOTE_SHA="$(git rev-parse --verify --quiet "origin/<branch>")"
  rc_resolve=$?
fi

# Checks 1 and 2 only run once the remote actually resolved — the guard, not the prose below,
# is what stops an unresolved (empty) REMOTE_SHA from ever reaching them.
LOCAL_SIDE=""
if [ "$rc_resolve" -eq 0 ]; then
  # Check 1's local side: the <pre-rebase-sha> step 2 reported for this push, once this branch's
  # own reflog shows the branch actually held it; HEAD otherwise. A sha the branch never held can
  # only fall back to HEAD, which over-reports and never under-reports.
  LOCAL_SIDE="HEAD"
  git log -g --format=%H "refs/heads/<branch>" > "<reflog-file>" 2> "<errfile>"
  rc_reflog=$?
  if [ "$rc_reflog" -eq 0 ] && grep -qxF "<pre-rebase-sha>" "<reflog-file>"; then
    LOCAL_SIDE="<pre-rebase-sha>"
  fi

  # Check 1 — the safety gate. Does the remote hold work absent locally? LOCAL_SIDE is the
  # later-push <pre-rebase-sha> whenever the reflog confirms this branch held it, and the remote
  # is literally an ancestor of that sha (it IS the remote plus this push's own commit, before any
  # rebase) — so a plain ancestry comparison answers the question directly; a rebased commit never
  # needs recognizing by its patch, because it was never on the far side of this diff to begin
  # with. A first-push <pre-rebase-sha> sits on the merge-base instead, so this guarantee — and a
  # first-push-rejected push routing here — is covered in the prose below, not here.
  git log --oneline --right-only "$LOCAL_SIDE...$REMOTE_SHA" > "<file>" 2> "<errfile>"
  rc_check1=$?

  # Check 2 — the discriminator. Is the remote an ancestor of local HEAD?
  # (--is-ancestor is reflexive: equal commits exit 0.)
  git merge-base --is-ancestor "$REMOTE_SHA" HEAD
  rc_check2=$?
fi

# Print every value a later, separate process reads below — this fence's shell variables do not
# survive into the guard or push fences that follow.
echo "rc_fetch=$rc_fetch"
echo "rc_resolve=$rc_resolve"
echo "rc_check1=$rc_check1"
echo "rc_check2=$rc_check2"
echo "LOCAL_SIDE=$LOCAL_SIDE"
echo "$REMOTE_SHA"    # report this as <remote-sha>
```

**`rc_fetch` non-zero means the fetch itself failed — stop.** Nothing below this line has a
freshly-fetched remote to resolve against: a stale `origin/<branch>` from before the failed fetch can
still resolve cleanly, which would let check 1 run against data that was never refreshed. The guard
above keeps `rc_resolve` unassigned in that state — the same "unassigned conjunct does not hold"
reasoning the push conjunction relies on below, applied one step earlier.

**`rc_resolve` non-zero means `origin/<branch>` did not resolve — stop.** Nothing below this line has
a remote to compare against, and the guard above keeps checks 1 and 2 from running at all in that
state: `<file>` is never written, `rc_check1` and `rc_check2` are never populated, so there is nothing
they could tell you.

**Check 1 passes only when `rc_check1` is 0 AND `<file>` is empty** — both, never empty alone. The
guard above already means `$REMOTE_SHA` is a valid, resolved sha by the time this command runs, so a
non-zero `rc_check1` here means the command itself failed against a real ref — a broken instrument to
repair, whatever `<errfile>` says why. An empty `<file>` alone is not a pass, because emptiness does
not discriminate: a check that passed with no divergent commits always writes nothing, and a command
that failed against a resolved ref can also write nothing. Emptiness is the signature of both, so
`<file>` on its own settles nothing — `rc_check1` is what tells the two apart. Once `rc_check1` is
confirmed 0 and `<file>` is confirmed to exist and be empty, that combination means what the safety
argument needs it to mean: the remote holds nothing you lack.

**Check 1 asks its question of the branch before step 2's rebase, not after it.** A rebase onto a
`main` that has moved gives those commits new shas, so a plain ancestry comparison against HEAD would
list the old remote commits as work absent locally — the team's own work, rebased, reported as
someone else's, on any push where `main` moved. The later-push `<pre-rebase-sha>` — built by resetting
onto `origin/<branch>` itself — is the remote plus this push's own commit, before any rebase, so asked
of it the question has the right answer: the remote is an ancestor of that `<pre-rebase-sha>` by
construction, so a remote holding only what the team pushed lists nothing, and a remote holding
anything else still lists it. A rejected first push that routes here is different: the first-push
`<pre-rebase-sha>` is built by resetting onto the merge-base with `origin/main`, not onto
`origin/<branch>`, so that same guarantee does not hold for it, and check 1 run against a first-push
`<pre-rebase-sha>` can over-report. Step 2's equivalence check is what carries the later-push answer
from the `<pre-rebase-sha>` to HEAD: equal means HEAD carries the approved change line for line, and
the approved change contains everything the remote had; unequal sends the interdiff to the senior,
where a hunk the rebase dropped shows as removed. The reflog read keeps a mistyped `<pre-rebase-sha>`
from standing in: a sha this branch never held leaves `LOCAL_SIDE` at HEAD, and a failed reflog read
does too — but HEAD is already past the rebase, so that fallback is exactly the case the first
sentence above describes: the old, pre-rebase remote commits are no longer ancestors of HEAD, and
check 1 lists them. That escalates a push that was actually safe; it never hides one that was not, so
the fallback is safe, only noisy — and rare, since it only triggers when the reflog does not confirm
the sha. A stale sha from an earlier push
passes the reflog read — the branch's reflog holds every sha it has ever pointed to, not only the
latest — but can only over-report: it predates whatever the remote gained after that push, so those
commits still get listed by check 1 rather than silently passed over.

**Check 2 tells you which push you are doing; check 1 alone settles whether it is safe.** `rc_check2`
is three-valued, not two. `0` means the remote is an ancestor — a plain fast-forward, and the
`--force-with-lease` form below is correct for it exactly as it is for a rebase, since the lease
matches either way — there is no separate plain-push command to reach for. `1` means history was
rewritten, which is the expected state after a rebase and exactly the case check 1 makes safe; it is
never on its own a reason to ask. Anything else (`128`) is an error, not a rebase, and fails the gate
below the same way a broken check 1 does.

**Push only when all of the following hold: `rc_fetch` is `0`, `rc_resolve` is `0`, `rc_check1` is
`0`, `<file>` exists and is empty, and `rc_check2` is `0` or `1`.** `rc_resolve` is only ever assigned
inside the `rc_fetch` guard above, and `rc_check1`/`rc_check2` are only ever assigned inside the
`rc_resolve` guard below that, so a non-zero `rc_fetch` leaves all three unassigned and a non-zero
`rc_resolve` leaves the latter two — an unassigned conjunct does not hold, so that alone fails the
gate regardless of which conjunct you check first. If any one of them does not hold, halt right here.
**`rc_check1` is `0` and `<file>` exists and is non-empty is the one halt that is a genuine board
question, whatever `LOCAL_SIDE` — the value this fence's print block printed — resolved to** — post it
now, under **Board Triggers (Unconditional)**
below, as **Blocked on a human decision**, naming what is on the remote that is not local (the
contents of `<file>`) and what you believe put it there; that is the case where work may be lost. When
`LOCAL_SIDE` fell back to `HEAD`, say in the prompt that the listed commits may instead be the team's
own rebased work — the fallback cannot tell them apart from someone else's, and it is rare, since it
only triggers when the reflog does not confirm the sha. **Halting for any other reason — a non-zero
`rc_fetch`, a `rc_check1` that did not
confirm `0`, or a `<file>` whose emptiness you could not confirm, whatever prevented it — is a broken
instrument to repair, not a board question and not a failed safety check.**

Check 1, together with step 2's equivalence check and interdiff review, is the whole safety argument:
nothing on the remote would be destroyed, because local already contains it, and nothing the rebase
reshaped was silently dropped along the way.

**One more check runs immediately before the push itself — confirming step 2's fold actually left one
commit above the base, and re-running the freshness test — not folding anything here:**

```bash
BASE_REF="refs/push-base/<branch>"
FROM_REF="refs/push-from/<branch>"
git rev-parse --verify --quiet "$BASE_REF" >/dev/null
rc_base_exists=$?
if [ "$rc_base_exists" -ne 0 ]; then
  echo "stop: $BASE_REF does not exist — step 2's Block A then Block B did not run for this push, or the ref was already cleaned up" >&2
  exit 1
fi

git merge-base --is-ancestor "$BASE_REF" HEAD
rc_base_ancestor=$?
if [ "$rc_base_ancestor" -ne 0 ]; then
  echo "stop: $BASE_REF is not an ancestor of HEAD (rc_base_ancestor=$rc_base_ancestor)" >&2
  exit 1
fi

REMOTE_NOW="$(git rev-parse --verify --quiet "origin/<branch>")"
rc_remote_now=$?
FROM_SHA="$(git rev-parse --verify --quiet "$FROM_REF")"
rc_from_sha=$?
if [ "$rc_remote_now" -gt 1 ] || [ "$rc_from_sha" -gt 1 ]; then
  echo "stop: git rev-parse --verify --quiet origin/<branch> or $FROM_REF failed (rc_remote_now=$rc_remote_now rc_from_sha=$rc_from_sha)" >&2
  exit 1
fi
if [ "$rc_remote_now" -ne 0 ] || [ "$rc_from_sha" -ne 0 ] || [ "$REMOTE_NOW" != "$FROM_SHA" ]; then
  echo "stop: $FROM_REF does not exist or origin/<branch> no longer matches it — re-run step 2's Block A then Block B" >&2
  exit 1
fi

ABOVE_BASE="$(git rev-list --count "$BASE_REF..HEAD")"
rc_above=$?
if [ "$rc_above" -ne 0 ] || [ "$ABOVE_BASE" -gt 1 ]; then
  echo "stop: $ABOVE_BASE commit(s) above $BASE_REF (rc_above=$rc_above) — broken instrument, not a board question: the implementer's fold in step 2 should have left at most one" >&2
  exit 1
fi
```

This step runs the same way whichever route reached it — its code reads only `refs/push-base/<branch>`,
`refs/push-from/<branch>`, `origin/<branch>`, and `HEAD`, resolving `origin/<branch>` itself. A
rejected first push rarely reaches this step — check 1 above almost always catches it first, since a
first-push `<pre-rebase-sha>` has no ancestry relation to whatever `origin/<branch>` already holds —
and if it does, the ref-existence check above stops it, since the first-push block never creates
`refs/push-base/<branch>` or `refs/push-from/<branch>`.

Then push, pinned to `<remote-sha>` — the literal value check 1's fence printed, carried forward the
same way as `<pre-rebase-sha>`:

```bash
git push --force-with-lease="<branch>:<remote-sha>" origin "<branch>"
```

Pin the lease to that literal value rather than using a bare `--force-with-lease`. Immediately
after the `git fetch` above the two forms are equivalent — both lease against the same value — so
the pin is not a second safety check, and it will not save you from a fetch that has already pulled
someone else's commit into your remote-tracking ref. **The lease pin is not itself part of the whole
safety argument above — check 1, the equivalence check, and interdiff review are.** What
the pin buys is that it freezes the value check 1 actually observed: a bare lease re-reads the
remote-tracking ref at push time, so any later `git fetch` — yours on a retry, or another session
working the same repo — silently re-arms it against a remote that has moved. The pinned value cannot
be re-armed that way.

**After a successful push, `refs/push-base/<branch>` and `refs/push-from/<branch>` have done their
job:**

```bash
git update-ref -d "refs/push-base/<branch>"
git update-ref -d "refs/push-from/<branch>"
```

A later push's step 2 recreates both fresh from `origin/<branch>` and `origin/main` at that time. A
ref left behind by an earlier, incomplete push cycle is not silently trusted the next time round: this
check above and step 2's fold both re-run the freshness test, so a stale leftover stops rather than
folding onto the wrong base.

**Out of scope — unchanged, still forbidden.** `main`, any shared or protected branch, any branch
the team did not create, and rewriting published history outside the team's own ticket branch —
anything another person may have based work on. Those stay on bright line 1 of
`skills/board/references/escalation-contract.md`.

## Board Triggers (Unconditional)

The board is the transport (`dashboard item add`, gated only by the board being present). The discipline this section enforces is *when* you MUST post — not whether an item "seems important enough." **Every trigger below is unconditional: when it occurs, you post — every time.** "I'll mention it in-session" or "this probably isn't worth an item" is the exact failure this list closes. Unconditional governs *whether* the user learns of it, not *when* an advancement approval goes up: of the four triggers below, only the **"ready" signal** may ever be held — and only while a question that could change the PR is open (`skills/board/references/dashboard-protocol.md` §3.1) — because the question is already on the board, so the user sees the state either way. Every other trigger below posts the moment it occurs; none of the other three may be held for any reason. None of these triggers fires for the workflow outside the story you are working — a monitor that misreports, a gate that will not clear, a step that contradicts another goes to the process improvement notes and nowhere else (`skills/board/references/escalation-contract.md` §Workflow improvements are notes).

Post the moment any of these occurs. The "ready" signal has no command block here — the
`CI_GREEN_ON_DRAFT`/`MERGE_READY` handlers above resolve it — and each other trigger carries its own:

- **Blocked on a human decision** — any open question you cannot proceed past: an architectural choice, an ambiguous or contradictory requirement, a trade-off only the user can make. You are paused until they answer. **Dashboard (required when the board is present — run it regardless; `dashboard-protocol.md` §1's CLI availability note covers which verbs report instead of silently no-opping):** same temp-file discipline as `CI_GREEN_ON_DRAFT`'s Dashboard step above, applied to `--recommend` and `--stalls` too — both are free text carrying the same backtick/`$` risk as `--prompt` — write `<one-line recommendation>` to `<tmpfile-recommend>`, `<what waits|none>` to `<tmpfile-stalls>`, and `<the question> — include enough markdown context to decide in place: the decision, options, and links` to `<tmpfile-prompt>` — that prompt is the
question and the context to decide it, nothing else: `--why-mine` already carries why it is yours, and restating it in prose is the padding `skills/board/references/escalation-contract.md` §Required question form forbids — then
`dashboard item add --type question --recommend "$(cat "<tmpfile-recommend>")" --stalls "$(cat "<tmpfile-stalls>")" --why-mine "<taste|scope|risk|teammate-unsettled|fact>" --prompt "$(cat "<tmpfile-prompt>")"`,
then `rm -f "<tmpfile-recommend>" "<tmpfile-stalls>" "<tmpfile-prompt>"` → capture `<id>`. Reconcile per `skills/board/references/dashboard-protocol.md` §4.
- **A "ready" signal** — CI has gone green on a draft PR (flip-to-ready-for-review), the bot reviewers are satisfied (request a human review), or a PR is approved and ready to merge. These are the `CI_GREEN_ON_DRAFT` event, the **Bots satisfied** check, and the `MERGE_READY` event above.
- **A credential / auth / environment ask** — CI needs a secret that isn't configured, a tool needs re-authentication, or an env var is missing. The work cannot advance until the user provides it. This is a credential ask, not an advancement approval — it must carry `--approval-kind credential` so the open-question guard doesn't mistake it for one (`skills/board/references/dashboard-protocol.md` §3.1). **Dashboard:** same temp-file discipline as `CI_GREEN_ON_DRAFT`'s Dashboard step above — write `<what's needed and why the work can't advance without it>` to `<tmpfile>` — that prompt is what is needed and what it unblocks, nothing else: a sentence naming whose call the secret is, or explaining what a blocked pipeline implies, is the padding `skills/board/references/escalation-contract.md` §Required question form forbids — then `dashboard item add --type approval --approval-kind credential --prompt "$(cat "<tmpfile>")"`, then `rm -f "<tmpfile>"` → capture `<id>`. Reconcile per `skills/board/references/dashboard-protocol.md` §4.
- **The harness paused the session** — a usage limit, a stalled teardown, or a similar external stop, with nothing for the user to decide: at most, wait for it to clear, or act directly to unblock the harness. Never declare `checkpoint` on a pause that has anything for the user to decide — a blocker a teammate surfaces mid-implementation is **Blocked on a human decision** above, not this. It must carry `--approval-kind checkpoint` so the open-question guard doesn't mistake it for an advancement approval (`skills/board/references/dashboard-protocol.md` §3.1). **Dashboard:** same temp-file discipline as `CI_GREEN_ON_DRAFT`'s Dashboard step above — write `<what paused and what would unblock it>` to `<tmpfile>` — that prompt is what paused and what would clear it, nothing else: a sentence naming whose call the wait is, or explaining what a paused session implies, is the padding `skills/board/references/escalation-contract.md` §Required question form forbids — then `dashboard item add --type approval --approval-kind checkpoint --prompt "$(cat "<tmpfile>")"`, then `rm -f "<tmpfile>"` → capture `<id>`. Reconcile per `skills/board/references/dashboard-protocol.md` §4.

**A throttled or refused CodeRabbit review is never one of these triggers.** The
`CODERABBIT_RATE_LIMITED` handler above re-requests it on a timer, with no cap, and never asks.

**Force-pushing the team's own branch is not one of these triggers.** With **Force-Pushing the Team's
Own Branch** above's push gate met, the push is an ordinary step — no item, and it is not an instance
of **Blocked on a human decision**. It becomes one when `rc_check1` is `0` and `<file>` exists and is
non-empty, whatever `LOCAL_SIDE` — the value check 1's fence printed — resolved to — the case where
work may be lost. When `LOCAL_SIDE` fell back to `HEAD` (**Force-Pushing the Team's Own Branch**
above), say in the prompt that the listed
commits may instead be the team's own rebased work, since the fallback cannot tell them apart from
someone else's. Any other
halt in that procedure — including a non-zero `rc_fetch` or a `rc_check1` that did not confirm `0` —
is a different case, a broken instrument to repair, not a board question.

**Step 2's own foreign-commit stop in Block A can raise this same condition earlier, before
Force-Pushing ever runs, pre-prep or post-prep alike.** It posts this item then, naming
`<foreign-commits-file>`'s contents, without the "may be the team's own rebased work" caveat — that
caveat is specific to `LOCAL_SIDE`'s fallback, which Block A's listing has no equivalent of: it
excludes exactly the commits reachable from HEAD or `refs/push-from/<branch>`, so whatever remains is
genuinely foreign regardless of prep state. When Force-Pushing's check 1 later lists the same commits,
that item already covers them — it does not post a second one.

Every trigger above waits for the user — the open item is what keeps the Stop hook watching for it. Once resolved (the user answers, approves the "ready" signal, provides the credential, or unblocks the checkpoint), reconcile it by **how** the user answered — `skills/board/references/dashboard-protocol.md` §4 — so it does not outlive the question.

**HOLD update rule (supersedes a prior "ready" item).** A "ready" item is not final. If any of the **non-question** invalidations arises *after* you have posted a "CI green", "bots satisfied", or "ready to merge" item but *before* the PR is merged — a new CI failure, a freshly pushed commit that needs re-review, a new review thread, a regression you discovered that doesn't itself need to be posed to the user as a question — post an immediate, unmistakable **HOLD** board item that supersedes the ready signal, *before* any merge proceeds. (A **question** that could change the PR is a different case, handled differently regardless of ordering — see step 9 above: withdraw the ready item instead of stacking a HOLD beside an open question, per `skills/board/references/dashboard-protocol.md` §3.1.) Round-trip the prompt through `<tmpfile>` first, same discipline as above — this is the one trigger where getting it wrong is worst: the mangled reason is what the user reads while deciding whether a merge is safe.

```bash
umask 077 && mktemp                       # write the prompt to <tmpfile>: *HOLD* — do not merge <PR link>. <what changed since the ready signal and why>. A new item will follow when it's ready again, and nothing else
                                          # a sentence naming whose call the hold is, or explaining what a superseded ready signal implies, is padding
dashboard item add \
  --type approval \
  --approval-kind hold \
  --prompt "$(cat "<tmpfile>")"
rm -f "<tmpfile>"
```

Never let a stale "ready" item stand once you know the PR is no longer mergeable — withdraw it (`dashboard item withdraw --item "<id>"`, and `playtest stop --name "<branch-name>-<repo-name>"` when it is the flip-to-ready item) and post the HOLD.

## Keep the PR's Written Artifacts True

A PR's write-ups are living documents, not write-once artifacts. **Before every push of new commits to an already-open PR**, re-read them against what those commits actually changed and correct whatever is now false:

- **The PR description** — round-trip through a *private* temp file, never a shell string (a PR body is full of backticks and `$`, which a double-quoted bash string command-substitutes and expands). Create the file with `umask 077; mktemp` and use the literal path it prints — carry that path across the steps as a literal, not a shell variable, because the read, your edit, and the write-back are separate Bash calls and shell state does not persist between them. Read with `gh pr view "<pr-number>" --repo "<owner/repo>" --json body --jq .body > "<tmpfile>"`, edit `<tmpfile>`, write it back with `gh pr edit "<pr-number>" --repo "<owner/repo>" --body-file "<tmpfile>"`, then `rm -f "<tmpfile>"`. Don't use a fixed path like `/tmp/pr-body.md` — this workflow runs many PR sessions at once, so a shared name collides (one run's body overwrites another's), and a predictable path can be pre-seeded as a symlink.
- **The design doc the work came from, when one exists** (`-2-arch.md`, `-1-bug.md`, or `-1-change.md`) — edit the local file in `docs/plans/`, re-run `skills/workflow-guide/references/notification-protocol.md` §Phase 0 so its diagrams and `hosted.md` match the edit, then re-sync its Notion page via the update path in §Phase 1 there (the file's `notion-page-id` — or legacy `notion_page_id` — frontmatter → `notion-update-page` with `replace_content`). Some paths have none (`skills/team-dispatch/SKILL.md` step 4 names them: quick-change, repeat-consolidation, design-skipped); skip this bullet on those rather than editing a document that does not exist.

Review feedback is the usual cause: the fix a reviewer asks for is often exactly the thing that falsifies the write-up. Typical drift — an approach the body still advertises but the code abandoned, a renamed file or flag, a scope bullet that no longer holds, a screenshot of superseded UI, an Out of Scope line in the design doc that the feedback pulled back into scope.

This is not cosmetic. Reviewers calibrate on the description; the design doc is what future work reads to learn how this was built; and whether the body outlives the PR is set by the repo's `squash_merge_commit_message` setting, which you read rather than reason about — `gh api "repos/<owner>/<repo>" --jq .squash_merge_commit_message`. `COMMIT_MESSAGES` composes the squashed message from the branch's commit messages and the PR body never appears in it; `PR_BODY` makes the body the permanent commit message; `BLANK` leaves it empty. Read the setting when the answer changes what you would do, and never carry an assumption about it into how you prioritise the body.

**The durable-references requirement on the body still applies on every reconciliation pass** — the
**Create the draft PR** step above sets it, and a fix that re-introduces a branch sha or a bare line
number is still a rot, just a later one.

**It is a step, not a gate** — no senior sign-off, no board item. Correct the prose and push. **It is not a license to redesign:** if the feedback changes the *design* rather than the wording, that is a human decision under **Board Triggers** above — post it, get the answer, then update the doc to record what was decided. The doc edit follows the decision; it never stands in for it.

Applies on every push to an open PR — feedback rounds, CI fixes, and the `MERGE_CONFLICT` rebase alike. The first `gh pr create` writes the body fresh, so it has nothing to reconcile yet.

---

Long-form guidance and event-handler rationale: read `references/pr-lifecycle-reference.md` — mandatory before your first run of this skill in a session.
