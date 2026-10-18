---
name: Board
description: The dashboard protocol every workflow shares — enter a session node, post questions and approvals, reconcile the user's answers, and never go quiet without posting first. Invoked by name by the workflow skills and by any other skill that needs the board. Triggers when a skill is about to take its first board action, or needs the question / approval / reconcile rules.
---

# Board

## Overview

Every workflow skill shares one dashboard protocol: enter a session node, post questions and approvals to the board before the terminal (or, with no board, in the terminal alone), reconcile answers by the channel they arrived on, and never go quiet while the user is waiting on you. This skill is the operational surface — the commands and when each runs. The full argument for each rule lives in `references/dashboard-protocol.md`; this file points at it rather than restating it.

## 1. Session enter

**Entry skills** run `dashboard session enter --phase "<phase>" [--title "<short description>"]` as their first action, before any research. Skills that re-enter an existing node do so at their own phase boundary. `--title` is only for a node's first enter — omit it on later re-enters, and use `--retitle` to rename one already entered. No `--key` for the root of the work; keyed re-entry to an existing ticket node resolves its key rather than writing the ticket id literally. A ticket-level node is not fully entered until its ticket link is registered once the ticket exists. **Run this on every run without exception** — it no-ops on its own if the `dashboard` CLI is absent, so run it regardless rather than skipping it on the assumption the dashboard is unavailable. See §1 for the key-resolution rules, the per-skill `--phase`/title table, and the ticket-link obligation.

## 2. Questions

**Earn the question first.** `skills/board/references/escalation-contract.md` is the gate: clear the three rungs — ask yourself, look it up, ask a teammate — and confirm the decision crosses one of the five bright lines, or is the sixth route (a **technical** disagreement you and a teammate could not settle on evidence) or the seventh (a fact only the user holds). A question that has not cleared the rungs is a call you were supposed to make, not an item you post. One that cleared them but crosses no bright line and takes neither route is yours to decide too, and you decide it rather than asking in the terminal — unless it is a deferral-gate post under contract rule 5. A small addition the team lead would recommend doing in this PR is done, not asked, subject to the scope test in `skills/board/references/escalation-contract.md` §The small-addition carve-out — it narrows bright line 4 only, and leaves the other four untouched.

A question that survives carries four things, in plain language throughout — no internal identifiers or workflow vocabulary unless the decision is about them: a **lede** (the decision in one line, actionable on its own), a **recommendation** (what you would do — always answerable), **what stalls** (or the word `none`), and **why it is the user's** (`taste`, `scope`, `risk`, `teammate-unsettled`, `fact`). After the lede goes the evidence — what you checked, the options, and a pointer to something the user can actually open; it is not optional, and it is what makes the question answerable. The declaration line the CLI composes from the other three closes the item. The exact three-block form, and the declaration line the last three go on, are in the contract's §Required question form. The CLI composes that declaration line itself from `--recommend`, `--stalls`, and `--why-mine` — do not write it by hand in `--prompt`. Add `--defer` for a deferral-gate post (contract rule 5, which requires `--stalls none`); with a board it queues the question on this node instead of posting it, printing `{"deferredId":"<id>"}` — mirror that queuing to the terminal the same as a posted question, since nothing reaches the board yet. With no board there is no queue to flush: `item add --defer` exits 3 and prints the question, and you ask it in the terminal now and wait for the reply. `dashboard item flush-deferred` posts every queued question as its own board item, all in one call, once there is a diff to point at (or, in a workflow with no PR, with no `--context` at all) (`references/dashboard-protocol.md` §2). Verify that evidence before posting — a repost costs the user the same attention twice.

Post it to the board first
(`dashboard item add --type question --recommend "<one line>" --stalls "<what waits|none>" --why-mine "<taste|scope|risk|teammate-unsettled|fact>" --prompt "$(cat "<tmpfile>")"` — temp file, never a shell string; why: `references/dashboard-protocol.md` §2)
— that prompt is the question and the context to decide it, nothing else: `--why-mine` already carries why it is yours, and restating it in prose is the padding `skills/board/references/escalation-contract.md` §Required question form forbids —
then mirror it to the terminal. With no board, `item add` exits 3 and prints the composed question instead: ask it in the terminal and wait for the reply there. Post independent questions together, in the same turn; ask dependent questions one at a time. **A question that stalls nothing waits for the diff** — hold it and post it once the PR exists, rather than interrupting mid-implementation. **Only where a PR is coming** — a workflow that produces none has no terminus, so the question posts now rather than being held. **Two kinds never qualify, however little they seem to stall:** a deferral-gate question (contract rule 5), and any question about the advancing PR's own content, scope, or review findings. §3 names both as always entangled and never judgement calls. A deferral-gate question is **recorded** the moment it fires — with a board, `--defer` queues it on the node, and `dashboard item flush-deferred` posts it later: against the diff where one exists, or, in a workflow that produces no PR, with no `--context` at all. With no board there is no queue to flush: `item add --defer` exits 3 and prints the question, and you ask it in the terminal now and wait for the reply. A question about the advancing PR's own content, scope, or review findings still **posts** the moment it fires. **Never hold a question that blocks.** If a question could change an approval you have already posted, withdraw the approval — do not delay the question. See §2. A question about the workflow outside the story you are working never earns this row — it goes to the process improvement notes and nowhere else (`skills/board/references/escalation-contract.md` §Workflow improvements are notes).

## 3. Approvals

Post an approval before waiting for it. An **advancement approval** — one that asks the user to move the work forward (flip to ready-for-review, merge, proceed to the next phase; illustrative, not exhaustive) — is exclusive: never post one while a question that could change it is still open, hold it until that question resolves. If the question arrives **after** you already posted the approval, withdraw it (`dashboard item withdraw --item "<id>"`) rather than leaving it standing, and post a fresh one once the question resolves, with `--replaces "<id>"` naming the one you withdrew. Post it as your next action then — not later.

Declare `--approval-kind` only on a HOLD item, a credential/auth/environment ask, or a checkpoint (a paused workflow with nothing to decide) — those are the only three approvals that are not advancement approvals. Declaring it on any other approval is **prohibited**, and never as a way past a refusal: if the CLI refuses, wait. Every approval that is not a HOLD, a credential ask, or a checkpoint is an advancement approval by construction.

**When you are unsure, hold** — holding costs one board round-trip; posting early costs the user a rejection they must compose. Holding is never the more expensive mistake. **A post that succeeds proves nothing:** the CLI's guard fails open whenever it cannot get a trustworthy count — §3.1 enumerates the cases — so never treat "the CLI let me" as having performed the check. Two cases are always entangled, never judgement calls: any question about a PR's content, scope, or review findings while that PR is what advances; and a deferral-gate question.

See §3 and §3.1 for the full argument and the fail-open analysis on the CLI's guard.

## 4. Reconcile by channel

Reconcile an item posted to the board by **how** the user answered, not by item type alone (with no board nothing was posted, so the terminal reply is acted on directly): an answer on the dashboard is consumed (`dashboard item consume --all`, or `--item "<id>"` when a sibling item is still open), an answer in the terminal uses `dashboard item answer --item "<id>" --response "$(cat "<tmpfile>")"` for a question (temp file, never a shell string — why: §4) and `dashboard item approve --item "<id>"` for an approval. Reading answers never consumes them. Full table and rules: §4.

## 5. Read the whole answer

The wake message the mod starts a turn with, and `dashboard answers` output, can each be multi-line — read the whole thing, and never `grep`, `tail`, `head`, or otherwise line-filter `dashboard answers` output. See §5.

## 6. Consume what you read

No exceptions: on a wake carrying `[dashboard] item <id> ...`, or after reading one with `dashboard answers` or `dashboard comments`, act on it, then consume the item (`dashboard item consume --item "<id>"` or `--all`) before you go idle or stop. The mod does not re-deliver it, but an unconsumed item stays released on the board and in `dashboard answers`, and reads as unanswered. Each item's `→` line names the exact command, and the Stop hook blocks a stop, as advice and only a bounded number of times, while it can see one that is unconsumed. When it cannot read the board it does not block, so the rule is still yours. Never reply to a comment only in the terminal, and never consume one you have not answered on the board, unless §6 exempts it: the reply is an item with `--answers "<comment id>"` posted on the node the comment was released on — a question where §6 calls for one, otherwise an info note — and the terminal comes second. See §6.

## 7. Parking

The board must say you are waiting before you go quiet. A blocker you discovered and scoped is yours to work, not a handoff — post the blocking item before you park.

**A stop-gate block naming no open item is an instruction to keep working, not to park.** End a turn only if you can name a specific pending thing and the event that will wake you — a teammate who owes you a reply, a background task that re-invokes you, or a monitor armed on a condition that can occur. **A usage-limit checkpoint is a park, and parks go on the board** — post what you were doing, the exact next step, and when the limit resets, before you go quiet — that prompt is the work in flight, the next step, and the reset time, nothing else: a sentence naming whose call the resume is, or explaining what a usage limit implies, is the padding `skills/board/references/escalation-contract.md` §Required question form forbids:
(`dashboard item add --type approval --approval-kind checkpoint --prompt "$(cat "<tmpfile>")"` — temp file, never a shell string; why: `references/dashboard-protocol.md` §2). See §7.

## 8. Info notes

A note tells the user something worth keeping that needs nothing from them:
`dashboard item add --type info --prompt "$(cat "<tmpfile>")"` (temp file, never a shell string).
It never puts the session under "Needs me", nothing answers it, and it is not a wait — never park on
one. Post one **on judgement**, when something the user would want later would otherwise be lost in
the thread — and never about a withdrawn question, not even why it was withdrawn. A progress update
is not a note, and anything that needs an answer is a question. A note never asks for a go-ahead:
anything that asks the user to approve, merge, flip, proceed or validate is `--type approval`,
however the moment was reached and whether or not the step's own instructions are still in context.
A note posted for one does not count as the step done; withdraw it
(`dashboard item withdraw --item "<id>"`) and post the approval. Every `--type info` post's result
carries this reminder in a `note` field. Three notes are prescribed, not judged: the Renovate monitor's `all-done` summary, the info-note reply that §6 prescribes where a board comment gets one, and the report of a ticket the workflow meant to move and could not. See §8.

Full protocol: references/dashboard-protocol.md — read it before your first board action in a session.
