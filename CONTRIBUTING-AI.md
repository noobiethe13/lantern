# Contributing with Claude Code

This project uses Claude Code with a structured setup. This guide is for
human teammates joining the repo: what to install, which commands exist,
where the guardrails are, and how to extend the setup itself.

(For Claude's own instructions, see [CLAUDE.md](CLAUDE.md).)

## 5-minute setup

1. Install Claude Code: https://code.claude.com/docs/en/overview
2. Open this repo in your terminal or IDE (VS Code / JetBrains
   extensions both work).
3. Run `/init` once and let it acknowledge the existing CLAUDE.md.
4. Run `/skills` and `/agents` to see what's wired up.
5. You're ready.

There is no separate API key step. Both the lantern app (for L2 verdicts and
NL→filter) and Claude Code itself use your Anthropic auth — lantern spawns the
`claude` CLI in headless mode over the same OAuth login. The `claude` CLI must
be on `PATH` for lantern's LLM features to work.

## Daily workflow

| Task                                    | Command                                  |
|-----------------------------------------|------------------------------------------|
| Implement a feature (multi-session)     | `/feature <description>`                 |
| Resume in-flight feature work           | `/feature` (no arg) or `/feature resume` |
| Quick cleanup of recently-changed code  | `/simplify` (built-in)                   |
| Project-aware PR review                 | `/pr-review [pr-number]`                 |
| Branch-diff security review             | `/security-review` (built-in)            |
| Codebase quality audit                  | `/quality-audit`                         |
| Work an item from the quality backlog   | `/remediate [issue-id]`                  |
| Codebase security audit                 | `/security-audit`                        |
| Root-cause investigation on a bug       | `/rca <symptom>`                         |
| Review project docs for drift           | `/docs-sync` (or `/docs-sync check`)     |
| Generate a new doc                      | `/docs-sync create <type>`               |

## Available skills (project-specific)

All eight project skills are configured with `disable-model-invocation:
true`. They run only when you invoke them by slash command — Claude
won't fire them on its own.

- **`/quality-audit`** — Deep code-quality audit. Forks to the
  `code-quality-auditor` agent. Appends new findings to
  `.claude/known-issues.md`. Run on team cadence (monthly, before
  releases), not per-PR.
- **`/feature <description>`** — Multi-session feature work using the
  3-file session-continuity pattern (plan.md / context.md / tasks.md
  under `.claude/session/<feature-slug>/`). Pass a description to
  start; later invocations resume the in-flight feature.
- **`/pr-review [pr-number]`** — Project-aware PR review. Forks to the
  `code-reviewer` agent. Knows lantern's architecture and the
  known-issues backlog so it doesn't re-flag triaged items. Replaces
  the deprecated built-in `/review`.
- **`/rca <symptom>`** — Root-cause analysis on a bug. Forks to the
  `bug-investigator` agent, which investigates and proposes a fix but
  does NOT apply it. Different from the built-in `/debug` (which
  debugs Claude Code itself).
- **`/remediate [issue-id]`** — Work through `.claude/known-issues.md`
  one item at a time. With no argument, picks the highest-severity
  oldest open item. Forks to the `code-quality-remediator` agent.
- **`/security-audit`** — Codebase-wide security audit. Forks to the
  `security-auditor` agent. Findings appended to
  `.claude/security-findings.md`. Distinct from `/security-review`
  (which is PR-diff scope).
- **`/docs-sync [check | create <doc-type>]`** — Manual docs
  maintenance. Forks to the `docs-maintainer` agent. With no argument
  or `check`, scans every `.md` file in the project (`.claude/`,
  top-level, `docs/`) for drift vs the codebase. With
  `create <doc-type>`, generates a new doc — README, LICENSE,
  CONTRIBUTING, CHANGELOG, ARCHITECTURE, ADR, or a free-form request.
  Never auto-edits human-authored docs.
- **`session`** — Reference-only skill, not a slash command. Documents
  the universal 3-file session-continuity pattern that any
  multi-session workflow should follow.

## Available agents (project-specific)

Six specialist agents back the workflow skills above. You generally
don't invoke them directly — the skill that owns each one delegates
when you run the corresponding slash command.

- **`code-quality-auditor`** — paired with `/quality-audit`. Read-mostly;
  appends only to `.claude/known-issues.md`.
- **`code-quality-remediator`** — paired with `/remediate`. Has
  project memory at `.claude/agent-memory/code-quality-remediator/`
  (auto-created on first invocation).
- **`security-auditor`** — paired with `/security-audit`. Read-mostly;
  appends only to `.claude/security-findings.md`.
- **`code-reviewer`** — paired with `/pr-review`. Has project memory
  at `.claude/agent-memory/code-reviewer/`.
- **`bug-investigator`** — paired with `/rca`. Read-only against the
  codebase; has project memory at `.claude/agent-memory/bug-investigator/`.
- **`docs-maintainer`** — paired with `/docs-sync`. Reviews every
  `.md` file in the project for drift and generates new docs on
  request. Never auto-edits human-authored docs (README, CHANGELOG,
  ARCHITECTURE, CONTRIBUTING, the prose sections of CLAUDE.md). Has
  project memory at `.claude/agent-memory/docs-maintainer/`.

The agent-memory directories don't exist on disk yet — they'll be
created the first time each agent runs and decides something is worth
remembering across sessions.

## Bundled tools also worth knowing about

Built-ins available without any per-project setup:

- **`/simplify`** — Reviews recently-changed code for reuse, quality,
  and efficiency, then fixes what it finds. Good as a quick pass after
  finishing a feature.
- **`/batch <task>`** — Parallel decomposition for large mechanical
  changes (e.g. rename across many files).
- **`/loop <interval> <prompt>`** — Repeat a prompt on a schedule
  (status polling, periodic checks).
- **`/debug`** — Debug a Claude Code session itself. Different from
  `/rca`, which investigates bugs in lantern.
- **`/security-review`** — Built-in security review of the pending
  changes on the current branch (PR-diff scope).
- **`/init`** — Initialize CLAUDE.md (already run for this repo;
  re-running is safe).

## Where Claude is blocked

This project does not currently configure any `permissions.deny` rules
in `.claude/settings.json`. Claude Code's own defaults apply:
write-confirmation prompts on file edits, prompts on shell commands
the user hasn't pre-approved, etc.

The hardest guardrails are not permission rules — they're the
**Critical rules** section in [CLAUDE.md](CLAUDE.md), which Claude
loads every session. Those cover: never edit `data/`, never call the
`claude` CLI directly (always via the `llm` singleton), all LLM
output goes through zod, no headless browser anywhere (liveness is
fetch-only), bind to localhost only, treat scraped/aggregator content as
an injection vector, keep the SSRF guard on every source adapter,
path-traversal-safe attachment handling.

If you find yourself wanting an automated block (e.g. preventing any
edit under `data/`), open `.claude/settings.json` and add a
`permissions.deny` entry. See
https://code.claude.com/docs/en/settings.

## How to add a Lesson Learned

The "Lessons Learned" section in [CLAUDE.md](CLAUDE.md) captures
recurring corrections so Claude doesn't repeat them. Two paths:

1. **You add it directly.** When Claude makes a recurring mistake on
   this codebase, append a line to the section. Keep entries factual:
   - Bad: "Claude keeps messing up the API responses lol"
   - Good: "API responses are camelCase on the wire, snake_case in
     internal types — convert at the boundary in `src/api/client.ts`"

2. **`/docs-sync` proposes one.** When you run `/docs-sync`, the
   `docs-maintainer` agent scans recent activity and may surface
   Lessons Learned candidates — a recurring correction across the
   working set, or a non-obvious gotcha worth recording. It asks for
   your approval before appending. The agent never auto-edits
   CLAUDE.md.

## How to add a known issue

Quality issues live in `.claude/known-issues.md` (created locally on first
run; it is not committed). The lifecycle is:

```
open → in-progress → fixed (and removed) | accepted | deferred
```

Three ways to populate it:

- Run `/quality-audit` to have the `code-quality-auditor` append findings.
- Add an entry yourself when you spot something worth tracking but
  don't want to fix right now.
- Triage a finding from a PR review into the backlog.

Use `/remediate` to work items one at a time. The remediator marks an
item `in-progress` while working, then `fixed` only after you confirm
the change works. Items in `accepted` state stay in the file as a
record of "we know, we chose not to" — future audits skip them.

## How to add a security finding

Same shape as the quality backlog, but in `.claude/security-findings.md`
(also local-only, not committed). Run `/security-audit` for periodic
full-codebase scans (write to the backlog) and `/security-review` per PR
(per-diff, results inline).

The two are distinct on purpose: `/security-audit` covers vulnerable
deps, the `claude` CLI subprocess boundary, source-adapter SSRF guards,
attachment handling, and the local HTTP server. `/security-review` covers
what just changed.

## Manual docs maintenance

Earlier iterations of this setup used a `PostToolBatch` ecosystem-review
hook that ran Haiku after every batch of tool calls. That has been
removed in favor of an explicit, user-driven workflow: run
`/docs-sync` when you want a docs check.

Why manual:

- Hook output was injected as context for Claude's next turn — you
  couldn't see it directly, and the signal was noisy on most batches.
- Most batches have nothing to flag, so the hook's gating logic grew
  complex and still ran on every batch.
- A single command you run on team cadence (or before a release) is
  easier to reason about and produces a clear, reviewable report.

What `/docs-sync` covers:

- Every `.md` file under `.claude/` (skills, agents, top-level
  backlogs), every top-level `.md` (README, CHANGELOG, ARCHITECTURE,
  CONTRIBUTING, CLAUDE.md), and everything under `docs/` (including
  ADRs).
- Index sync between CLAUDE.md and `.claude/skills/` /
  `.claude/agents/`.
- Stale command/path/library references vs the current `package.json`
  and `src/`.
- Backlog freshness — file paths in `open` known-issues / security
  findings that no longer exist.
- Cross-doc consistency — same fact stated differently in two places.

`/docs-sync create <type>` generates new docs from scratch (README,
LICENSE, CONTRIBUTING, CHANGELOG, ARCHITECTURE, ADRs). Existing files
are never overwritten — the agent switches to suggesting an update
patch instead.

## Contributing to the setup itself

To extend Claude's project capabilities:

- **Add a skill**: create `.claude/skills/<name>/SKILL.md` with YAML
  frontmatter (`description:` is required; `disable-model-invocation:
  true` if you only want it on slash invocation; `agent:` if it should
  fork to a specialist agent).
- **Add an agent**: use `/agents` (interactive) or write
  `.claude/agents/<name>.md` directly.
- **Add a rule**: create `.claude/rules/` (doesn't exist yet) and add
  per-path rule files. Use the `paths:` frontmatter for path-scoping
  so the rule only loads when relevant files are in context.
- **Add a hook**: extend `.claude/settings.json` under `hooks`. Use
  `type: command` for shell scripts, `type: prompt` for inline
  LLM-driven hooks. There are no project-level hooks configured today.

When you add a skill or agent, also update the `Skills available in
this project` and `Agents available in this project` indexes in
[CLAUDE.md](CLAUDE.md). Run `/docs-sync` afterwards to confirm the
indexes match what's on disk.

For richer skill scaffolding (with eval support), install
`/skill-creator`:

```
/plugin install skill-creator@claude-plugins-official
```

## Troubleshooting

- **"`/quality-audit` isn't picking up new files I created"** — Claude Code
  watches directories live, but newly-added top-level skill
  directories may need a session restart before they appear in
  `/skills`.
- **"`/docs-sync` flagged drift that isn't actually drift"** — tell the
  agent in chat. It writes accepted exceptions to
  `.claude/agent-memory/docs-maintainer/` so future runs skip them.
- **"Token cost feels high after this setup"** — run `/context` to see
  what's loading per session. Path-scoped rules and skills with
  `disable-model-invocation: true` shouldn't load unless triggered.
- **"An agent has stale memory and gives wrong answers"** — open the
  relevant `.claude/agent-memory/<agent>/MEMORY.md`, find the entry
  pointing to the wrong file (or specifically the wrong file name),
  and edit or delete it. Memory is just files; nothing magical.
