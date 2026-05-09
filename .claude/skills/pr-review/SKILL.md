---
description: Project-aware PR review using the code-reviewer agent. Knows lantern's architecture, the known-issues backlog, and the team's accumulated review nits. Replaces the deprecated built-in /review.
disable-model-invocation: true
argument-hint: "[pr-number]"
arguments: pr_number
context: fork
agent: code-reviewer
allowed-tools: Read, Grep, Glob, Bash(git:*), Bash(gh pr:*)
---

# /pr-review

Run a project-aware PR review using the `code-reviewer` agent.

## Context

- Branch: !`git branch --show-current`
- Main branch: !`git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "master"`
- Diff size (vs main): !`git diff master...HEAD --shortstat 2>/dev/null || echo "(could not compute)"`
- Open known-issues count: !`grep -c "^- \*\*State\*\*: open" .claude/known-issues.md 2>/dev/null || echo "0"`
- PR number requested: $pr_number

## Task

Execute Phases 1–3 from your agent system prompt. If `$pr_number` is
empty, review the diff between current branch and the main branch.
Otherwise, use `gh pr diff $pr_number`.

Output the structured review (Critical / Should fix / Consider /
Strengths). After the user reacts to specific findings, update your
project memory accordingly.
