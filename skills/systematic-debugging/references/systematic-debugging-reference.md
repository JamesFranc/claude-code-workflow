# Systematic Debugging — Reference

Long-form guidance and rationale for the Systematic Debugging skill. Read this once before your first run of the skill in a session — the numbered checklist in `SKILL.md` is what you execute against.

## Iron Law Framing

Random fixes waste time and create new bugs. Quick patches mask underlying issues.

**Core principle:** ALWAYS find root cause before proposing fixes. Symptom fixes are failure.

**Violating the letter of this process is violating the spirit of debugging.**

This skill is the entry point for bug reports, test failures, and unexpected behavior. It investigates the root cause, decides whether a code change is required, and — if so — writes a bug summary doc and hands off to Team Dispatch for the full implementation chain (plan → team → review → PR → monitor → cleanup). If no code change is needed, it exits cleanly.

**The boundary — enter before you investigate.** The moment you encounter a bug, failing test, or unexpected behavior, you are already in this skill. Reading a log, reproducing, or opening a file to diagnose is Phase 1 of *this skill* — not something you do before invoking it. Do not investigate ad-hoc first and formalize later; enter here (Phase 1's mandatory first action is `dashboard session enter`), then investigate inside it.

```text
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you haven't completed the investigation, you cannot propose fixes, write a bug summary doc, or hand off to Team Dispatch.

**The Iron Law applies to tickets you file about your own code, too.** `NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST` isn't only for bugs handed to you — construct the failing state before filing, don't file from reading alone. (FLOW-135 and FLOW-134 were both filed from reading the code, not from a reproduced failure, and both were wrong.)

## When to Use

Use for ANY technical issue:
- Test failures
- Bugs in production
- Unexpected behavior
- Performance problems
- Build failures
- Integration issues

**Use this ESPECIALLY when:**
- Under time pressure (emergencies make guessing tempting)
- "Just one quick fix" seems obvious
- You've already tried multiple fixes
- Previous fix didn't work
- You don't fully understand the issue

**Don't skip when:**
- Issue seems simple (simple bugs have root causes too)
- You're in a hurry (rushing guarantees rework)
- Manager wants it fixed NOW (systematic is faster than thrashing)

## Root Cause Investigation Technique

**BEFORE proposing any fix:**

### 1. Read Error Messages Carefully
- Don't skip past errors or warnings
- They often contain the exact solution
- Read stack traces completely
- Note file paths, symbols, and error codes — with line numbers as locators while you work; a finding travels into the bug summary doc by symbol — or a quoted literal where no symbol exists — since the doc outlives the lines (`skills/workflow-guide/references/durable-references.md`)

### 2. Reproduce Consistently
- Can you trigger it reliably?
- What are the exact steps?
- Does it happen every time?
- If not reproducible → gather more data, don't guess
- Verify the symptom against reality, not against a report — read the actual log/file/DB row/process state, don't trust an error summary, a dashboard, or a teammate's paraphrase of what happened. The bug is in the system's real state, not in the description of it.

### 3. Check Recent Changes
- What changed that could cause this?
- Git diff, recent commits
- New dependencies, config changes
- Environmental differences

### 4. Gather Evidence in Multi-Component Systems

**WHEN system has multiple components (CI → build → signing, API → service → database):**

**BEFORE proposing fixes, add diagnostic instrumentation:**
```text
For EACH component boundary:
  - Log what data enters component
  - Log what data exits component
  - Verify environment/config propagation
  - Check state at each layer

Run once to gather evidence showing WHERE it breaks
THEN analyze evidence to identify failing component
THEN investigate that specific component
```

### 5. Trace Data Flow

**WHEN error is deep in call stack:**

- Where does bad value originate?
- What called this with bad value?
- Keep tracing up until you find the source
- Fix at source, not at symptom

### 6. Find Working Examples

- Locate similar working code in the same codebase
- What works that's similar to what's broken?
- If implementing a pattern, read the reference implementation COMPLETELY — don't skim
- List every difference between working and broken, however small
- Don't assume "that can't matter"

### 7. Form a Hypothesis

- State clearly: "I think X is the root cause because Y"
- Be specific, not vague
- If you can't name a root cause, keep investigating — do not proceed to the decision point with "it's probably X"
- If the evidence for your hypothesis is a tool's output (a linter, scanner, profiler, or a CI log), reproduce that output yourself before you build the fix on it — run the tool on the failing state and confirm it says what the report claims. A root cause inferred from an unreproduced tool claim is a guess wearing a citation.

### When You Don't Know

- Say "I don't understand X"
- Don't pretend to know
- Ask for help
- Research more

## Bug Summary Doc Template

The bug summary doc is the PRD+architecture hybrid for bug flows. It is only written when a code change is required. With no ticket, omit the `**Jira:**` line.

~~~markdown
# [Bug title] — Bug Summary

**Jira:** [TICKET-ID]

## Problem Statement
What's broken, observed symptoms. 1-3 sentences.

## Reproduction
Minimal steps to trigger the bug. Environment, inputs, expected vs. actual.

## Root Cause
What's actually wrong and why, traced to source (not symptom). Reference
the file or component where the defect lives, but not line-level detail —
that goes in the implementation plan.

## Proposed Fix
High-level approach. What changes, what the new behavior is. Interfaces
and contracts only — no function bodies.

## Scope
Bullet list of what the fix touches.

## Out of Scope
Bullet list of what we're explicitly NOT fixing in this change.

## User Impact
Who's affected, severity, whether it's user-visible.

## Risks / Open Questions
Known unknowns, regression risks, things to validate during implementation.
~~~

**Diagrams.** None is required. When one helps, put it under the section it explains, written per
`skills/workflow-guide/references/diagrams.md`.

**No section restates another.** The overlap to watch is `Scope` against `Proposed Fix`:
Scope names what the fix touches, the approach section says what it does. If one
has become a reworded copy of the other, delete the weaker rather than trimming both. Length is the
defect and repetition is its worst form.

**Brevity never costs the reader the specification.** Cut preamble, restatement and hedging. Do
**not** cut data structures, schemas, API contracts, reproduction steps, commands or error text to
make a document shorter — those are what the reader came for. A short document that omits the
contract is not concise, it is unusable.

**No people's names.** The bug summary is about the defect, its root cause, and the fix — not who
reported or found it. No names, usernames, or handles
(`skills/workflow-guide/references/no-people-names.md`).

Skippable sections: any that don't apply to this bug (e.g., trivial repro, no open questions).

## Red Flags — STOP and Follow Process

If you catch yourself thinking:
- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "Skip the bug summary, I'll just fix it"
- "Skip Team Dispatch, the change is small"
- "I'll write a test after confirming the fix works"
- "It's probably X, let me fix that"
- "I don't fully understand but this might work"
- "Here are the main problems: [lists fixes without investigation]"
- Proposing solutions before tracing data flow
- **"One more fix attempt" (when already tried 2+)**
- **Each fix reveals a new problem in a different place**

**ALL of these mean: STOP. Return to checklist step 2 (the investigation sequence).**

**If 3+ fixes failed inside Team Dispatch:** Question the bug summary doc (see the checklist's 3-failure STOP rule).

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Issue is simple, don't need process" | Simple issues have root causes too. Process is fast for simple bugs. |
| "Emergency, no time for process" | Systematic debugging is FASTER than guess-and-check thrashing. |
| "Just try this first, then investigate" | First fix sets the pattern. Do it right from the start. |
| "I'll skip the bug summary doc, the fix is obvious" | The doc is a review gate, not ceremony. It's fast when the fix is obvious. |
| "I'll skip Team Dispatch, the fix is one line" | Team Dispatch self-abbreviates. A one-line fix still gets a plan, review, and PR. |
| "Multiple fixes at once saves time" | Can't isolate what worked. Causes new bugs. |
| "Reference too long, I'll adapt the pattern" | Partial understanding guarantees bugs. Read it completely. |
| "I see the problem, let me fix it" | Seeing symptoms ≠ understanding root cause. |
| "One more fix attempt" (after 2+ failures) | 3+ failures = wrong bug summary. Question the doc, don't fix again. |
