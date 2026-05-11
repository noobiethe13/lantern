---
description: Run a deep code-quality audit of the lantern codebase. Appends new findings to .claude/known-issues.md (skips already-tracked items). Run on team cadence — monthly, before releases — not as part of every-PR flow.
disable-model-invocation: true
context: fork
agent: code-quality-auditor
allowed-tools: Read, Grep, Glob, Edit, Bash(git log:*), Bash(git diff:*)
---

# /quality-audit

Run a deep code-quality audit of the `lantern` codebase using the
`code-quality-auditor` agent.

## Context

- Project: !pwd
- Branch: !`git branch --show-current`
- Last audit identified date: !`grep "^- \*\*Identified\*\*" .claude/known-issues.md 2>/dev/null | tail -1 | sed 's/^- \*\*Identified\*\*: //' || echo "(no prior audit found)"`
- Open issue count: !`grep -c "^- \*\*State\*\*: open" .claude/known-issues.md 2>/dev/null || echo "0"`
- src/ exists: !`test -d src && echo "yes" || echo "no — lantern may be pre-implementation; report and exit cleanly"`

## Task

Execute Phases 1–4 from your agent system prompt. Append new findings to
`.claude/known-issues.md`. Skip items already tracked in
accepted/deferred state.

After completion, summarize findings in chat for the user. If new
findings were added, suggest running `/remediate` to begin working
through them.
