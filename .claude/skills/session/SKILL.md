---
description: Universal 3-file session-continuity pattern (plan.md / context.md / tasks.md under .claude/session/<work-slug>/) for any work spanning multiple Claude Code sessions. Reference this from any workflow that may extend beyond one session — features, multi-session remediations, complex investigations, architectural overhauls.
disable-model-invocation: true
---

# Session Continuity

This is the **universal** pattern for multi-session work in this project.
Any agent or workflow skill that takes on work plausibly spanning multiple
Claude Code sessions should set up the 3-file working set BEFORE starting.

`/feature` already uses this. Multi-session `/remediate` and complex `/rca`
should follow the same shape rather than reinventing it.

## The 3 files

All under `.claude/session/<work-slug>/` — gitignored, local working state,
not committed:

### plan.md
The high-level plan. What we're building, in what order, with what
constraints. Updated when the plan itself changes — not on every step.

Structure:
- **Goal** — 1–2 sentences.
- **Constraints** — must / must not / nice-to-have.
- **Approach** — numbered phases.
- **Open questions** — items that need user input before proceeding.

### context.md
Working knowledge accumulated during the work. Things you'd otherwise
have to re-derive next session.

Structure:
- Key files touched and why.
- Patterns / conventions discovered (especially anything Claude tripped on).
- External constraints (API quirks, dependency limitations) that shaped
  the approach.
- Decisions made and why — especially decisions that closed off other
  approaches.

### tasks.md
The concrete work items, with state.

Structure:
- One section per phase from `plan.md`.
- Inside each phase: checklist of tasks
  (`- [ ]` open, `- [~]` in-progress, `- [x]` done, `- [-]` skipped).
- After each task, optional 1-line note: commit hash, test result,
  blocker found.

## Discipline

- One task `[~]` at a time. Mark `[x]` only when verified.
- Update `tasks.md` as you go — don't batch updates at the end.
- Update `context.md` whenever you make a decision a future-you would
  ask "why" about.
- Update `plan.md` only when the plan itself changes (re-scope, new
  phase, approach change). Don't keep stale guidance lying around.
- Don't write to these files just to seem productive — every entry
  should be something a future session would actually read.

## Resuming a session

When starting a new session on existing work:
1. Read `plan.md`, `context.md`, `tasks.md` in that order.
2. Restate where we are and what comes next.
3. Confirm with the user before proceeding.
4. Continue from the next `[ ]` task.

## When to retire the files

When the work is complete and committed:
- The 3 files have served their purpose.
- If parts of `context.md` captured generalizable lessons (a recurring
  gotcha, an undocumented convention), move those to CLAUDE.md's
  **Lessons Learned** section first.
- Then delete the directory, OR rename to
  `.claude/session/_done/<work-slug>/` if the user wants an archive.

## When this pattern applies

- `/feature` — implementing a feature.
- `/remediate` — multi-session refactors from `.claude/known-issues.md`.
- `/rca` — root-cause investigations that span sessions.
- Architectural overhauls.
- Any planned change with more than ~half a day of expected work.

**Not** for simple single-session work — the 3-file overhead isn't
worth it.

## .gitignore

`.claude/session/` is already gitignored at the repo root. Do not commit
files under it.
