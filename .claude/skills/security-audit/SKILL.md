---
description: Run a codebase-wide security audit of lantern. Distinct from /security-review (which is PR-diff scope). Findings appended to .claude/security-findings.md. Run periodically (monthly) and before any external-facing release.
disable-model-invocation: true
context: fork
agent: security-auditor
allowed-tools: Read, Grep, Glob, Edit, Bash(bun pm ls), Bash(git log:*)
---

# /security-audit

Run a periodic security audit of the `lantern` codebase using the
`security-auditor` agent.

## Context

- Project: !`basename $(pwd)`
- Last audit date: !`grep "^- \*\*Identified\*\*" .claude/security-findings.md 2>/dev/null | tail -1 | sed 's/^- \*\*Identified\*\*: //' || echo "(no prior audit found)"`
- Open security finding count: !`grep -c "^- \*\*State\*\*: open" .claude/security-findings.md 2>/dev/null || echo "0"`
- Critical open count: !`grep -B1 "^- \*\*Severity\*\*: critical" .claude/security-findings.md 2>/dev/null | grep -c "^- \*\*State\*\*: open" || echo "0"`

## Task

Execute Phases 1–3 from your agent system prompt. Append new findings to
`.claude/security-findings.md`. Skip items in accepted/deferred state.

After completion, summarize in chat. Critical findings get an explicit
callout. Do NOT propose auto-fixes — surface for human triage.
