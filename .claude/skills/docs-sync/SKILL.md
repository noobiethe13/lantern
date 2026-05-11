---
description: Manually maintain project documentation. Two modes — drift check across all .md files (CLAUDE.md, .claude/, README, ARCHITECTURE, CHANGELOG, CONTRIBUTING, docs/, ADRs), or generate a new doc (README, LICENSE, CONTRIBUTING, CHANGELOG, ARCHITECTURE, ADR, custom). Run on team cadence — monthly, before releases — or anytime you need a doc created.
disable-model-invocation: true
argument-hint: "[check | create <doc-type> | <free-form-request>]"
arguments: action
context: fork
agent: docs-maintainer
allowed-tools: Read, Grep, Glob, Edit, Write, Bash(git log:*), Bash(git diff:*), Bash(git status:*), Bash(ls:*), Bash(find:*)
---

# /docs-sync

Manually run docs maintenance for the `lantern` project using the
`docs-maintainer` agent. Use this occasionally to keep documentation
aligned with the codebase, or to generate a new doc.

## Context

- Project: !pwd
- Branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -20 2>/dev/null || echo "(no git history)"`
- Top-level .md files: !`ls *.md 2>/dev/null || echo "(none)"`
- LICENSE present: !`ls LICENSE* 2>/dev/null || echo "no"`
- .claude .md files: !`find .claude -name "*.md" -not -path ".claude/agent-memory/*" 2>/dev/null | head -40`
- docs/ directory: !`test -d docs && find docs -name "*.md" 2>/dev/null | head -20 || echo "(no docs/ directory)"`
- Action: $action

## Task

Execute Phases 1–4 from your agent system prompt.

**Mode dispatch — choose based on `$action`:**

- Empty or `check` → run a full drift scan across every project .md file. Output a structured drift report.
- `create README` → generate `README.md` at the repo root.
- `create LICENSE` → ask which license, then generate `LICENSE`.
- `create CONTRIBUTING` → generate `CONTRIBUTING.md`.
- `create CHANGELOG` → generate `CHANGELOG.md` seeded from recent commits.
- `create ARCHITECTURE` → generate `ARCHITECTURE.md`.
- `create ADR <topic>` → generate `docs/adr/NNNN-<topic>.md` using the next available ADR number.
- Anything else → treat as a free-form documentation request and use judgment.

## Rules

1. **Never auto-edit human-authored docs** — surface drift as suggested
   patches the user can review and apply.
2. **Generation only for files that don't yet exist.** If the target file
   exists, switch to suggesting an update rather than overwriting.
3. **Always cite file:line** in drift findings.
4. **Be conservative** — false positives waste the user's time.

## After completion

Summarize in chat. If the agent generated a new doc, show its path. If
drift was found, group by severity and suggest the next action. If
nothing needed attention, say so plainly.
