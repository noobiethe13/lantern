---
description: Multi-session feature work for lantern. Uses the 3-file session-continuity pattern (plan.md / context.md / tasks.md under .claude/session/<feature-slug>/) so feature work survives across separate Claude Code sessions. Pass a short feature description as the argument; subsequent invocations resume the in-flight feature.
disable-model-invocation: true
argument-hint: "<feature-description-or-resume>"
arguments: description
allowed-tools: Read, Edit, Write, Grep, Glob, Bash
---

# /feature

Multi-session feature work using the 3-file session-continuity pattern.

## Context

- Branch: !`git branch --show-current`
- In-flight features: !`ls .claude/session/ 2>/dev/null | grep -v project-intent.md | grep -v findings.md || echo "(none)"`
- Argument: $description

## Task

### If this is a NEW feature

1. Slugify `$description` into `<feature-slug>` (kebab-case, ≤6 words).
2. Create `.claude/session/<feature-slug>/`. Inside it:
   - `plan.md` — the design and approach (you draft after talking to
     the user; check it in once stable)
   - `context.md` — running notes: decisions made, files touched, gotchas
     hit, what to remember when resuming
   - `tasks.md` — checklist of work items, in execution order, with
     status (`[ ]`, `[~]` in-progress, `[x]` done)
3. Walk through Phase 1: understand the request, propose 2–3 approaches,
   pick the simplest that fits (per CLAUDE.md universal principles).
4. Once aligned with the user, write `plan.md` and an initial `tasks.md`.
5. Begin executing the first task; update `tasks.md` as you go; update
   `context.md` with anything a future session would need.

### If RESUMING an existing feature

1. If `$description` matches an existing `.claude/session/<slug>/` (or
   says "resume" with no slug given), pick that one. If multiple
   in-flight, ask the user to choose.
2. Read `plan.md`, `context.md`, and `tasks.md` in that order.
3. Restate where we are and what comes next; ask user to confirm before
   proceeding.
4. Resume executing the next `[ ]` task.

### Discipline

- One task in `[~]` at a time. Mark `[x]` only when verified.
- Update `context.md` whenever you make a decision a future-you would
  ask "why" about.
- If the plan changes mid-stream, edit `plan.md` (don't keep stale
  guidance lying around).
- Surface anything that warrants its own backlog item to `/quality-audit`'s
  `known-issues.md` rather than absorbing it into the feature scope.

## Verification before declaring the feature done

Per CLAUDE.md universal principles (Goal-Driven Execution):
- Run available verification: `bun test`, `tsc --noEmit`,
  `bun run healthcheck`
- For UI: state explicitly that you cannot verify without a browser
- Self-critique: would a senior engineer approve this as
  production-ready?

When the feature is done and merged, archive the session directory
(rename to `.claude/session/_done/<feature-slug>/` or delete — user's
call).
