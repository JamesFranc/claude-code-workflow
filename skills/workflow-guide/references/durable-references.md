# Durable References — cite the thing, not its coordinates

A reference is **durable** when a reader can resolve it, and get the same answer, from `origin/main`
after a squash merge. Anything else is a coordinate into a state that no longer exists.

This file is the single authoritative statement of that rule. Consumer skills state the obligation
at the point where they produce or check a reference and point here for the rest.

## Why this class is expensive

A rotted reference does not look rotted. It fails no test, trips no gate, and goes on asserting its
stale value in exactly the confident tone it had when it was true. Three forms, one failure — a
mutable reference recorded as though settled:

| what rots | how it rots |
|---|---|
| a commit sha | an amend orphans it within the hour; a squash merge collapses every branch commit |
| a line number | the edit that cites it inserts lines above its own target and shifts it |
| a measured figure | it was true for the sample that produced it, and the sample was never stated |

**We squash merge.** Every commit on a branch stops being an ancestor of `origin/main` at merge — a
stray ref (a PR's `refs/pull/N/head`, a fork) can keep the sha resolvable, but ancestry — not
existence — is what a reviewer tests. A sha written into anything that outlives the branch fails that
test on arrival, not merely at risk.

## The test

> Would a reader resolve this reference, and get the same answer, from `origin/main` after a squash
> merge?

If no, it is a coordinate, not a citation — replace it with the thing itself.

## Where the rule binds

| Channel | Lifetime | What is required |
|---|---|---|
| A message to a teammate in the same worktree, a researcher's report, a live review finding | this session | the symbol — or a quoted literal where no symbol exists — with the line beside it as a locator; the line locates, the symbol is what survives it |
| A code comment, plan, design doc, change summary, bug summary, ticket, PR title, PR body, memory, review-standards file | after the branch is gone | a symbol or a quoted literal — never a bare line number; a sha that is an ancestor of `origin/main` — never one that isn't, with the exclusions §What to check names; a measured figure with its sample stated — never bare |

The ephemeral channel is not a loophole. A researcher's summary and a review finding are exactly how
a line number gets pasted into a plan, which is why the symbol — or the literal, where no symbol
exists — is required there too.

## 1. Symbols over line numbers

Anchor on the symbol — a function, class, constant, type, heading, or a quoted literal from the file.

- **Durable:** the `--root` flag on `linkAddCommand` in `tools/cli/src/commands/dashboard.ts`
- **In-session:** `_place_wells()` — `village_layout.gd:342`
- **Never:** see `village_layout.gd:342`

A line number may ride along as a hint; it may never be the thing the reader has to trust. **The most
fragile citation of all is one into a file the same change edits** — your own insertions above it
shift it before the commit is finished. Re-derive it after the edit, or drop it and keep the symbol
(or the literal).

Where no symbol exists — a config value, a line of prose — quote the literal text instead. A quoted
string is greppable, and grep survives everything a line number does not.

## 2. Content over shas

Quote the before/after text rather than naming the commit that holds it. Content is durable because
it is the thing itself.

When a sha genuinely is the reference — the commit that introduced a defect, the commit a regression
test pins — it must be reachable from `origin/main`:

```bash
git merge-base --is-ancestor "<sha>" origin/main && echo durable || echo "DANGLING — will vanish"
```

Pick a sha that is already on `main`. A branch sha, a sha you amended, and a sha from a PR that has
not merged are none of them guaranteed to stay an ancestor of `origin/main`, and the artifact naming
one keeps reading as though it were verified.

## 3. Provenance on measured figures

A number you obtained by running something carries the quantifier it earned: what was sampled, how
much of it, and when.

- **Durable:** "max 32 over 50 seeds (2026-08-18)"
- **Never:** "tops out near 25"

If what the reader needs is the *current* value, give the command that re-derives it instead of the
value. A figure with no sample beside it is an unverified universal wearing the costume of a fact.

## What to check

No tool runs this — a reviewer checks it by reading. Three things, in the diff:

- **Every `path:NNN`** needs a symbol or a quoted literal beside it. A line reference counts whether
  it's written `path:42` or arrives as a GitHub `#L42` permalink (`.../blob/<sha>/file.ts#L42`) — the
  permalink form rots twice, a line number and a branch sha in the same link, and it's the shape most
  likely to show up in a PR body. A bare line number, in either form, standing alone, is a finding.
- **Every sha cited as a durable reference** must be an ancestor of `origin/main`. For a single
  reference you're judging, §2 above has the one-line test (`git merge-base --is-ancestor`). Three
  kinds of hex token are outside this rule rather than failures of it: a fixture value — a synthetic
  literal in a test, or a real sha minted by a throwaway repo built for a proof transcript, neither of
  which names anything in this repo's history; a round-scoped ledger entry — a `--reviewed-sha` passed to `review-ledger round-close` or `review-ledger next-round`,
  or a `--fix-commit` passed to `review-ledger finding status`, including one quoted in prose that
  documents a round; and a ledger **finding id**, which is a content hash rather than a sha and
  resolves to no git object at all, so the ancestry test cannot even be run on one. The two
  ledger-entry flavours name a pre-squash branch commit *on purpose*: the round they describe
  happened there, and rewriting them to a post-merge sha would make them name a commit that did not
  exist when the round ran. Everything else a diff, a PR title, or a PR body cites as a sha is in
  scope. This bullet is the authority on that boundary; consumers state it by pointing here.
- **Every measured figure** needs its sample — what was sampled, how much, and when — or the
  command that re-derives it.

**The PR title and body are durable channels too, and neither is in the diff.** A squash merge makes a
title the commit subject; which one is set by the repo's `squash_merge_commit_title` setting, and
whether the body survives at all by its `squash_merge_commit_message` setting — read both rather than
assuming either. Whichever title lands outlives the branch, so once a PR exists, check both against
the same three rules above.

**Judgement no rule above substitutes for:**
- A figure stated flatly carries no hedge word to flag it — "max 32" needs its sample exactly as
  much as "tops out near 25" does; don't let the absence of a qualifier like "about" or "roughly"
  read as though the figure were sourced.
- A hex-looking token in the diff or in a PR title/body may be a UUID, a fixture hash, or a config
  id rather than a commit sha — read it before treating it as one.
- A line number sitting beside a symbol is the durable form working as intended, not a violation —
  the symbol is what survives; the line is the hint riding along with it.
