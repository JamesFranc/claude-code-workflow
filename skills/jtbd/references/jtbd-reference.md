# Jobs to be Done — Reference

Long-form guidance, templates, and rationale for the JTBD skill. Read this once before your first run of the skill in a session — the numbered checklist in `SKILL.md` is what you execute against.

## Overview

Understand the problem before solving it. This is the first gate in the skill chain — it always runs, but abbreviates itself when the answer is already clear.

**Announce at start:** Adapt to the situation:
- If exploring: "I'm using the JTBD skill. I have some questions to understand what we're solving."
- If clear: "I'm using the JTBD skill. The problem is clear from [X], so I'll write up the PRD directly."

**When NOT to use:** If the work is a small, well-understood change that follows an existing pattern (a tweak, small enhancement, refactor, or copy/config edit), use Quick Change (`workflow:quick-change`) instead — it writes one combined change summary doc rather than a separate PRD and architecture doc. JTBD is for substantial work with real problem or design space to explore.

## Gather Context

Before asking any questions, understand what's already known:
- Check the current project state (files, docs, recent commits)
- Read any linked Jira tickets or referenced documents
- Review the conversation for context the user has already provided
- **Research the codebase before asking questions.** If the user's request references existing code, read relevant files first. Don't ask questions you could answer by exploring the project. Come to the conversation informed.

## Assess Clarity

After gathering context, decide how much questioning is needed:

- **Problem is already clear** (e.g., obvious bug with known root cause, well-defined request with clear scope) — Write up the PRD directly. No questions needed. Move on.
- **Problem is partially clear** — Ask questions to fill the gaps. Don't re-ask what's already known.
- **Problem is vague or complex** — Full Socratic exploration.

If skipping questions, briefly state why: "The problem is clear from the error logs — writing up the PRD."

**Default to asking questions.** Err on the side of more conversation, not less. The PRD should feel like a natural output of a thorough conversation, not something the model rushed to produce. If in doubt, ask.

## Socratic Exploration

Ask questions one at a time to understand:
- What job is the user trying to get done?
- What's the current experience? What's broken or missing?
- Who is affected and how?
- What does success look like?
- What's in scope and what's not?
- What has been tried before? What didn't work?
- Are there constraints (timeline, budget, team, dependencies)?

**Do NOT rush to the PRD.** The conversation IS the value. Each question should build on the previous answer. Don't ask generic questions — tailor them to what the user just told you. If an answer surfaces new complexity, explore it before moving on.

Only move to the PRD when you have a clear, shared understanding of every section. If you're unsure about something, ask — don't guess and write it into the PRD for the user to correct.

**Dashboard question protocol (required when the board is present — run it regardless; `dashboard-protocol.md` §1's CLI availability note covers which verbs report instead of silently no-opping):** post to the board first, then mirror to the terminal (with no board, ask in the terminal alone) — full protocol: `skills/board/references/dashboard-protocol.md` §2.

**Rules:**
- One question per message for **dependent** questions (each builds on the last); when you have multiple **independent** questions, post them together per the dashboard question protocol so the user isn't pulled back repeatedly
- Prefer multiple choice when possible, but open-ended is fine
- **`AskUserQuestion` is banned while a board is available** (blocked by a hook then — see the contract; with no board, ask in the terminal). A question for the user, clarifying ones included, goes on the board with its options inline in the evidence; otherwise decide and state it in plain prose.
- Suggest possibilities — don't just ask, propose
- If the user starts diving into implementation, gently redirect: "Let's nail down what we're solving first, then we'll get into the how."

**CRITICAL — Stay in problem space.** Do NOT ask about or suggest:
- Technology choices (languages, frameworks, libraries, databases)
- Architecture (APIs, services, data models, sync vs. async)
- Implementation approach (how to build it, what code to write)
- Repos, file structure, or infrastructure

These belong in the Architecture skill (`workflow:architecture`), which runs AFTER this one. If you're tempted to ask "should we use X technology?" or "would a queue work here?" — STOP. That's architecture. Ask about the PROBLEM instead: who has it, what they need, what success looks like.

**DO NOT include in the PRD:**
- Function names, variable names, or class names
- File paths or directory structures
- Specific imports or library references
- Hardcoded values, ARNs, URLs, or config snippets
- Technology choices or framework references
- Code snippets or pseudocode

If you find yourself writing something that belongs in a code editor, stop — it belongs in the Architecture skill (`workflow:architecture`), not here.

**Describe intent, not current state.** When scoping, describe what should happen ("subscribe all outbox topics"), not an enumeration of what currently exists ("subscribe these 27 topics: ..."). The current state is a snapshot that will be stale by implementation time. The intent survives.

## Write the PRD

Write a PRD-style document. **Keep it concise.** Use bullet points, not paragraphs. Each section should be scannable in seconds, not a wall of text.

```markdown
# [Title]

**Jira:** [TICKET-ID]

## North Star — what we are really trying to accomplish
> Short, strongly-worded statement of the real goal and the bar we are held to.
> Write it in plain, forceful language — the one or two sentences that say what
> success really means and why the work matters.
> The user verifies this wording is right before the JTBD gate is passed.
> `/reload-goal` reads this block to re-anchor a drifting agent, so it must stand on its own.

## Problem Statement
1-3 sentences. What job needs to be done and why.

## Success Criteria
Bullet list. Concrete, verifiable outcomes — not vague goals.
- "Auth errors drop to <1% of login attempts"
- NOT "Authentication is improved"

## Scope
Bullet list of what's included.

## Out of Scope
Bullet list of what we're NOT doing (and why, if not obvious).

## User Impact
1-2 sentences. Who this affects and how.

## Diagrams (when helpful)
Use diagrams to visualize the problem space — D2 for flows,
relationships, and states, Mermaid only for sequences
(`skills/workflow-guide/references/diagrams.md`). Every leaf box
(not a container) takes a `class:` role, which that file maps for
problem-space diagrams; a leaf box without one fails the render.
These are NOT architecture or solution diagrams — they
show the problem:
- User flows (how users move through a process today vs. desired)
- Relationship diagrams (entities and how they relate)
- State diagrams (what states something moves through)
- Simple flowcharts (current process that's broken or manual)

Only include diagrams when they clarify something that words
alone don't. Not every PRD needs them.

## Context / Background
Bullet list. Prior art, constraints, related tickets.
```

The `**Jira:** [TICKET-ID]` line uses the ticket ID from ticket creation; with no ticket, omit the line.

**No people's names.** The PRD is about the problem and the outcome, never about who asked for it or
who said what — no names, usernames, or handles (`skills/workflow-guide/references/no-people-names.md`).

**Write the North Star first and confirm it.** Phrase it in plain, forceful language — the real goal and the bar, not a restatement of the title. Confirm the wording with the user before passing the JTBD gate; the user owns this sentence. Because it lives on disk in the PRD, it survives compaction — `/reload-goal` re-reads it to re-anchor an agent that has drifted on a long job.

Do NOT dump the PRD into the terminal. Write it directly to file and open it for review.

**File naming:** `docs/plans/YYYY-MM-DD-<topic>-1-prd.md`

The `1` prefix ensures PRDs sort before architecture docs (`2-arch`) and implementation plans (`3-impl`) for the same topic.

Tell the user the PRD is ready for review and wait for their feedback. Be ready to revise — re-save and re-open (or re-sync to Notion) after changes.

## After the PRD (chain discipline)

**Abbreviating does not mean skipping the chain.** Writing a short PRD is fine; bypassing Architecture and Team Dispatch to edit files directly is not. However small the change, the work still flows JTBD → Architecture → Team Dispatch — the downstream skills abbreviate themselves, they don't get skipped. (If the work is small enough that this feels heavy, it likely belonged in Quick Change — `workflow:quick-change` — from the start.)
