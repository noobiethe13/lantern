---
description: Work through .claude/known-issues.md one item at a time. With no argument, picks the highest-severity oldest open item. With an argument like ISSUE-003, picks that specific item.
disable-model-invocation: true
argument-hint: "[issue-id]"
arguments: issue_id
context: fork
agent: code-quality-remediator
allowed-tools: Read, Edit, Write, Grep, Glob, Bash
---

# /remediate

Pick a quality issue from `.claude/known-issues.md` and work through it
one item at a time using the `code-quality-remediator` agent.

## Context

- Backlog exists: !`test -f .claude/known-issues.md && echo "yes" || echo "no — run /audit first"`
- Open count: !`grep -c "^- \*\*State\*\*: open" .claude/known-issues.md 2>/dev/null || echo "0"`
- In-progress count: !`grep -c "^- \*\*State\*\*: in-progress" .claude/known-issues.md 2>/dev/null || echo "0"`
- Requested issue ID: $issue_id

## Task

Execute Phases 1–5 from your agent system prompt. If `$issue_id` is
empty, pick the next item per the priority rule (critical > high >
medium > low; ties broken by oldest-identified). Otherwise, find and
work the requested item.

Wait for user approval after Phase 2 (plan) before executing.
Wait for user confirmation after Phase 4 (verification) before closing.
