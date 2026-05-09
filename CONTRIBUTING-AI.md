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

There is no separate API key step. The lantern app itself uses the
Gemini CLI subprocess (Google AI Pro OAuth); Claude Code uses your
Anthropic auth.

## Daily workflow

| Task                                    | Command                                  |
|-----------------------------------------|------------------------------------------|
| Implement a feature (multi-session)     | `/feature <description>`                 |
| Resume in-flight feature work           | `/feature` (no arg) or `/feature resume` |
| Quick cleanup of recently-changed code  | `/simplify` (built-in)                   |
| Project-aware PR review                 | `/pr-review [pr-number]`                 |
| Branch-diff security review             | `/security-review` (built-in)            |
| Codebase quality audit                  | `/audit`                                 |
| Work an item from the quality backlog   | `/remediate [issue-id]`                  |
| Codebase security audit                 | `/security-audit`                        |
| Root-cause investigation on a bug       | `/rca <symptom>`                         |

## Available skills (project-specific)

All seven project skills are configured with `disable-model-invocation:
true`. They run only when you invoke them by slash command — Claude
won't fire them on its own.

- **`/audit`** — Deep code-quality audit. Forks to the
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
- **`session`** — Reference-only skill, not a slash command. Documents
  the universal 3-file session-continuity pattern that any
  multi-session workflow should follow.

## Available agents (project-specific)

Five specialist agents back the workflow skills above. You generally
don't invoke them directly — the skill that owns each one delegates
when you run the corresponding slash command.

- **`code-quality-auditor`** — paired with `/audit`. Read-mostly;
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
loads every session. Those cover: never edit `data/`, never call
Gemini's HTTP API directly, Playwright is sequential, all Gemini
output goes through zod, bind to localhost only, treat scraped HTML as
an injection vector, never log the persisted browser-profile session,
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

2. **The ecosystem-review hook proposes one.** When the hook spots a
   pattern worth recording (a recurring correction across a batch, a
   non-obvious gotcha just encountered), it surfaces the proposal in
   Claude's context. Claude then asks for your approval before
   appending. The hook never auto-edits CLAUDE.md.

## How to add a known issue

Quality issues live in [.claude/known-issues.md](.claude/known-issues.md).
The lifecycle is:

```
open → in-progress → fixed (and removed) | accepted | deferred
```

Three ways to populate it:

- Run `/audit` to have the `code-quality-auditor` append findings.
- Add an entry yourself when you spot something worth tracking but
  don't want to fix right now.
- Triage a finding from a PR review into the backlog.

Use `/remediate` to work items one at a time. The remediator marks an
item `in-progress` while working, then `fixed` only after you confirm
the change works. Items in `accepted` state stay in the file as a
record of "we know, we chose not to" — future audits skip them.

## How to add a security finding

Same shape as the quality backlog, but in
[.claude/security-findings.md](.claude/security-findings.md). Run
`/security-audit` for periodic full-codebase scans (write to the
backlog) and `/security-review` per PR (per-diff, results inline).

The two are distinct on purpose: `/security-audit` covers vulnerable
deps, persisted state, the Gemini subprocess boundary, attachment
handling, and the local HTTP server. `/security-review` covers what
just changed.

## Ecosystem-review hook

A `PostToolBatch` hook configured in `.claude/settings.json` runs
after every batch of tool calls. It uses Haiku and a 30-second timeout
to detect drift between `.claude/` infrastructure and other artifacts:

- Triggers on edits to `.claude/`, CLAUDE.md, CONTRIBUTING-AI.md, the
  backlog files, or `docs/`.
- Also triggers on volume (3+ Edit/Write calls in one batch) — but
  only enables the "Lessons Learned candidates" check in that case.
- Outputs JSON `additionalContext` for Claude's next turn. You don't
  see the output directly; Claude reads it and surfaces actionable
  items to you.
- Never auto-modifies human-authored files (CLAUDE.md, README,
  CHANGELOG). Lessons-Learned and stale-doc suggestions always require
  your sign-off.

If the hook ever fires too aggressively, two options:

- Adjust the prompt's confidence threshold inline in
  `.claude/settings.json`.
- Disable temporarily: `/hooks` → toggle PostToolBatch.

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
  LLM-driven hooks (like the existing ecosystem-review hook).

When you add a skill or agent, also update the `Skills available in
this project` and `Agents available in this project` indexes in
[CLAUDE.md](CLAUDE.md). The ecosystem-review hook will flag drift if
you forget.

For richer skill scaffolding (with eval support), install
`/skill-creator`:

```
/plugin install skill-creator@claude-plugins-official
```

## Troubleshooting

- **"`/audit` isn't picking up new files I created"** — Claude Code
  watches directories live, but newly-added top-level skill
  directories may need a session restart before they appear in
  `/skills`.
- **"The ecosystem hook never fires"** — confirm `.claude/settings.json`
  is valid JSON (any JSON validator works; or paste it into a
  syntax-highlighter). A parse failure silently disables the hook.
- **"I see the hook noted drift but Claude didn't act on it"** — the
  hook injects context for Claude's next turn. If Claude's turn ends
  immediately after the hook fires, the context goes unread. Continue
  the session and Claude will see it.
- **"Token cost feels high after this setup"** — run `/context` to see
  what's loading per session. Path-scoped rules and skills with
  `disable-model-invocation: true` shouldn't load unless triggered.
- **"An agent has stale memory and gives wrong answers"** — open the
  relevant `.claude/agent-memory/<agent>/MEMORY.md`, find the entry
  pointing to the wrong file (or specifically the wrong file name),
  and edit or delete it. Memory is just files; nothing magical.
