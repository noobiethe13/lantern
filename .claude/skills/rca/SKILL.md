---
description: Root-cause analysis on a lantern bug. Investigates and proposes a fix; does not apply it. Pass the symptom or error message as the argument.
disable-model-invocation: true
argument-hint: "<bug-description-or-error-message>"
arguments: symptom
context: fork
agent: bug-investigator
allowed-tools: Read, Grep, Glob, Bash(git:*), Bash(bun:*)
---

# /rca — Root-cause analysis

Investigate a lantern bug using the `bug-investigator` agent. Read-only
investigation; outputs a proposed fix for human review.

## Context

- Branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -10 2>/dev/null || echo "(no git history)"`
- Symptom: $symptom

## Task

Execute Phases 1–4 from your agent system prompt. The user has supplied
the symptom in `$symptom`; if it's empty or vague, ask one clarifying
question.

Output the structured RCA report (Root cause / Evidence / Proposed fix /
Risk / Verification plan / Alternatives). Do not edit any file.
