---
name: workflow-guide
description: Use at the start of every conversation before doing any work — checks which workflow skills apply to the user's request and ensures the right skill chain is followed. Triggers on any new task, feature request, bug report, documentation change, or work request.
---

# Workflow Guide

## Overview

Before starting any work, check which workflow skills apply. **Whenever you are about to write documentation or work on code — any change to code, config, docs, or plans — or the moment you hit a bug, failing test, or unexpected behavior, route it through the matching workflow first.** Don't jump straight to coding, debugging, writing docs, or planning without first considering the skill chain. This is a very strong expectation, not a hard block — treat skipping the workflow as the exception you must justify, not the default.

## Skill Chain

These skills form a pipeline. Each is a gate — always evaluated, but can self-abbreviate when the answer is obvious.

| Skill | Invocable name | When to use | Entry point? |
|-------|---------------|------------|--------------|
| **JTBD** | `workflow:jtbd` | Substantial new work — a feature or anything with real design space to explore | Yes — start here for substantial new work |
| **Architecture** | `workflow:architecture` | After JTBD, when technical design is needed | Invoked by JTBD |
| **Team Dispatch** | `workflow:team-dispatch` | After Architecture, to plan and execute a story | Invoked by Architecture |
| **Code Review** | `workflow:code-review` | Used by the senior engineer inside Team Dispatch | Invoked by Team Dispatch |
| **Systematic Debugging** | `workflow:systematic-debugging` | Bugs, test failures, unexpected behavior — investigates, writes a bug summary doc if a fix is needed, then chains into Team Dispatch | Yes — start here for debugging |
| **Quick Change** | `workflow:quick-change` | Small, well-understood non-bug changes — tweaks, small enhancements, refactors. Writes one combined change summary doc, then Team Dispatch | Yes — start here for small changes |
| **Git Worktrees** | `workflow:git-worktrees` | When setting up isolated workspaces | Used by Team Dispatch and on demand |
| **Branch Setup** | `workflow:branch-setup` | Ensures a feature branch before edits (hook-triggered or manual) | Hook-triggered; also on demand |
| **Syncing Plans to Jira** | `workflow:syncing-plans-to-jira` | Syncs task checklist to Jira after writing a plan | Invoked by Team Dispatch |
| **PR Feedback** | `workflow:pr-feedback` | When the user asks about PR review comments | Yes — start here for PR reviews |
| **PR Lifecycle** | `workflow:pr-lifecycle` | After senior review, to create PR and monitor it | Invoked by Team Dispatch |
| **Process Improvement Notes** | `workflow:process-improvement-notes` | Track process observations during any workflow | Invoked by Team Dispatch; also on demand |
| **Memory Review** | `workflow:memory-review` | Curate the persistent memory store at end-of-project — capture, reconcile, cull, promote — and route the user's review standards to the file the senior engineer reads | Invoked by Team Cleanup; also on demand |
| **Team Cleanup** | `workflow:team-cleanup` | After PR merge, to clean up worktrees and team | Invoked by Team Dispatch |
| **Board** | `workflow:board` | The shared dashboard protocol — session enter, questions, approvals, reconcile | No — invoked by the others |

## The hard rules and full protocols

The hard rules live in `contract.md` (injected every session by the session-start hook) — workflow-first routing, board-first decisions, the structural question-tool block, the don't-re-ask rule, the deferral gate, and — for a closed, enumerated set of actions — workflow-invocation precedence over harness user-conditionals.

The output style lives in `output-style.md`, injected every session by the same hook in its own block — how replies to the user are written: lead with the answer, no preamble or recap or closers, state the fact rather than explain the mechanism behind it, and the three carve-outs that keep brevity from costing the reader anything (a length cap never truncates a list whose completeness is its value, suppressing a tangent never suppresses the board post contract rule 5 requires, and cutting an explanation never cuts anything rule 9 protects). A missing or empty `contract.md` is fatal; a missing or empty `output-style.md` warns and degrades, so losing the prose rules never costs a session its process rules.

The keep-it-simple rules live in `keep-it-simple.md`, injected every session by the same hook in a third block, and into every subagent by the same hook's `subagent` mode on SubagentStart — how code is built: the ladder (need, reuse in this codebase, standard library, native platform, installed dependency, one line, then the minimum code), no unrequested abstraction or scaffolding, root-cause bug fixes, deliberate shortcuts named in a comment, and what is never simplified away. A missing or empty `keep-it-simple.md` warns and degrades, like the output style. The review checklist's over-engineering findings point at it (`skills/code-review/references/review-rules.md`).

The full protocols live in `references/`:
- `references/routing.md` — decision logic, dashboard session nesting, research delegation, orchestrator anti-patterns, cross-phase rules
- `references/notification-protocol.md` — document and evidence-file hosting (Notion) + notification delivery (dashboard link; local path when no board)
- `references/diagrams.md` — how to draw diagrams in workflow docs: D2 for structure in the house style, Mermaid for sequences
- `references/install-dependencies.md` — how to install a repo's dependencies, cited by every skill that creates a worktree, checks out or rebases a branch, or pulls main

The dashboard protocol — session enter, question protocol, approval-gate protocol, reconcile-by-channel, read-the-whole-answer (multi-line), consume-what-you-read, parked-session board rule — lives in `workflow:board`, invoked by the other skills.

Everything else this skill used to state inline now lives in one of the files enumerated above or in `workflow:board`, not duplicated here.
