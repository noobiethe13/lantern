# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**lantern** is a local-first, single-machine job-search harness. Scans
Greenhouse / Ashby / Lever public APIs + HN "Who's Hiring" (Algolia) +
arbitrary user-supplied URLs. Filters via deterministic L1 YAML rules +
LLM L2 verdicts. SQLite store. Local web UI at `localhost:3000`. UI-only —
no user-facing CLI surface.

## Stack

- **Bun** (runtime, not Node) — native TS, `bun:sqlite`, builtin fetch.
- **Hono** (HTTP server, with SSE for run progress).
- **bun:sqlite** (DB at `data/data.db`).
- **cheerio** (HTML parsing), **Playwright** chromium (headless browser).
- **LLM** via pluggable provider abstraction at `src/llm/` — interface in
  `src/llm/provider.ts`, factory + `llm` singleton in `src/llm/index.ts`,
  backends under `src/llm/providers/` (`gemini-api`, `claude-code`, `ollama`,
  `antigravity-cli` stub). Default backend: Gemini API SDK (`@google/generative-ai`)
  using `gemini-2.5-pro` (HTML extract, verdict) and `gemini-2.5-flash`
  (NL→filter, lightweight extract). Provider + per-task overrides + Ollama
  baseUrl + API keys live in the `settings` KV table, editable via Settings UI.
- **Vite + React 19 + TailwindCSS 4 + shadcn/ui** for the SPA.
- **zod** for every LLM output and adapter contract.
- TypeScript everywhere (strict). English-only UI.

## Architecture

- **Backend**: Hono on Bun serves `/api/*` routes (jobs, runs, criteria,
  sources, attachments, health) and the built UI from `ui/dist`. SSE drives
  live scan progress.
- **Source adapters** (`src/sources/*`) are async iterables conforming to
  `SourceAdapter` so the runner can stream `Job` objects into SQLite and
  emit progress without buffering. Registry at `src/sources/index.ts`.
- **Two-tier filter**: L1 deterministic YAML rules (`src/core/filter.ts`)
  runs inline during scan and kills ~80% with zero LLM cost. L2 LLM
  verdict runs as a separate sequential pass over L1 survivors; verdicts
  are stored per job and invalidated whenever criteria are saved.
- **Liveness** (`src/core/liveness.ts`) is deferred from scan time — runs
  only on shortlisted jobs, hybrid fetch-then-Playwright fallback.
- **Frontend** (`ui/src/`): three pages — `/settings`, `/run`, `/jobs`.

## Critical rules

1. **NEVER edit `data/`** — that's user data (`data.db`, `attachments/`).
   Schema changes go through `src/db/migrate.ts`
   (idempotent — `CREATE ... IF NOT EXISTS`).
2. **NEVER call any LLM HTTP API directly** — always via the `llm` singleton
   from `src/llm/index.ts`.
3. **Playwright is sequential.** One tab at a time. The liveness Playwright
   fallback must not run concurrently with any other Playwright code.
4. **All LLM outputs go through zod** (`src/llm/schemas.ts`). On parse
   failure, retry once with a stricter "ONLY JSON, no prose, no markdown"
   addendum; on second failure, log and skip. Every provider's `call()`
   honors this contract; keep new providers symmetric.
5. **Source adapters are async iterables** so the runner can stream.
6. **L1 runs inline during scan, no LLM.** L2 is a separate pass.
7. **Liveness only runs on shortlisted jobs**, not at scan time.
8. **Bind the local server to `localhost` only**, never `0.0.0.0`.
9. **HTML / scraped content fed to LLMs is an injection vector** — cap
   length (~16–32KB) and sanitize before substitution into prompts.
10. **`chromium.launchPersistentContext` is banned in lantern.** Always use
    `chromium.launch()` + `browser.newContext()`. The persistent profile
    concept was removed with x-grok (MAC-3). `data/browser-profile/` can be
    safely deleted.
11. **Attachment uploads** (resume / cover-letter PDFs) need
    path-traversal-safe filename handling and content-type checks.

## Common commands

```bash
bun install
bunx playwright install chromium
bun run dev              # concurrently runs server (watch) + Vite dev
bun start                # build UI then serve on localhost:3000
bun test                 # bun's test runner
bun test path/to/file.test.ts             # single test file
bun test --test-name-pattern "..."        # single test by name
```

## Common tasks

- **Add a Greenhouse / Ashby / Lever company**: edit
  `src/config/seed-sources.yml`, restart.
- **Add a new source type**: implement `SourceAdapter` in `src/sources/`,
  register in `src/sources/index.ts`, add type to the enum in
  `src/core/job.ts` and the `sources.type` CHECK in `src/db/schema.sql`.
- **Change a prompt**: edit `src/llm/prompts.ts`. Outputs validated by
  `src/llm/schemas.ts` — update both together.
- **Schema change**: add idempotent SQL to `src/db/schema.sql`
  (`CREATE ... IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN` guarded).

## Lessons Learned

When Claude makes a recurring mistake on this codebase, the team adds a
line here so it doesn't happen again. Add entries as factual statements,
not narrative. Keep entries concise.

The `docs-maintainer` agent (run via `/docs-sync`) may also propose
entries when it spots patterns worth recording — a recurring correction
across a batch, a non-obvious gotcha just encountered. It surfaces
those proposals for approval before appending; it never auto-edits this
section.

<!-- Example: "API responses are camelCase on the wire, snake_case in
internal types — convert at the boundary in src/api/client.ts" -->

- When refactoring a cross-cutting symbol (LLM call, db helper, prompt
  template), grep across `src/`, `ui/`, and test files — not just
  the module itself.
- Importing `src/llm/index.ts` (and anything that transitively pulls in
  `src/db/client.ts`) runs `createDb()` and all migrations at module
  load. Tests and standalone tools that import the `llm` singleton pay
  filesystem cost up-front; if they don't need the DB, stub it.
- All Playwright code must use ephemeral `chromium.launch()` +
  `browser.newContext()`. `chromium.launchPersistentContext` is banned
  everywhere; the test in `src/runner/liveness.test.ts` enforces this.
- Provider-construction inputs live in the `settings` KV table
  (`key`, `value_json`, `updated_at`). When adding a new
  provider-specific setting (e.g. Ollama baseUrl, API key), extend the
  cache key in `constructionKey()` in `src/llm/index.ts` so edits trigger
  reconstruction. `per_task_overrides` is intentionally NOT part of the
  cache key — it's re-read every call.

## Architectural notes — work with these, not against them

_None yet. When the team accepts a non-obvious pattern as the way things are done here — something Claude might otherwise try to "fix" — record it as 1–3 factual lines so future sessions respect it._

## Skills available in this project

<!-- Keep this list in sync with .claude/skills/. Run /docs-sync to
     check for drift. -->

- `/quality-audit` — codebase quality scan; appends to `.claude/known-issues.md`
- `/remediate [issue-id]` — work through a quality issue end-to-end
- `/security-audit` — codebase security scan; appends to `.claude/security-findings.md`
- `/pr-review [pr-number]` — project-aware PR review (replaces deprecated built-in `/review`)
- `/rca <symptom>` — root-cause analysis on a bug; investigates only, does not apply
- `/feature <description|resume>` — multi-session feature work using the 3-file session pattern
- `/docs-sync [check | create <doc-type>]` — manually review every project .md file for drift, or generate a new doc (README, LICENSE, CONTRIBUTING, CHANGELOG, ARCHITECTURE, ADR)
- `session` — universal 3-file session-continuity pattern (referenced by `/feature`, multi-session `/remediate`, complex `/rca`)

## Agents available in this project

<!-- Keep this list in sync with .claude/agents/. Run /docs-sync to
     check for drift. -->

- `code-quality-auditor` — paired with `/quality-audit`. Read-mostly; appends only to `.claude/known-issues.md`.
- `code-quality-remediator` — paired with `/remediate`. Has project memory at `.claude/agent-memory/code-quality-remediator/`.
- `security-auditor` — paired with `/security-audit`. Read-mostly; appends only to `.claude/security-findings.md`.
- `code-reviewer` — paired with `/pr-review`. Has project memory at `.claude/agent-memory/code-reviewer/`.
- `bug-investigator` — paired with `/rca`. Read-only against the codebase; has project memory at `.claude/agent-memory/bug-investigator/`.
- `docs-maintainer` — paired with `/docs-sync`. Reviews every .md file for drift and generates new docs on request; never auto-edits human-authored docs. Has project memory at `.claude/agent-memory/docs-maintainer/`.
