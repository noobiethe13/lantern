# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**lantern** is a local-first, single-machine job-search harness. Scans
Greenhouse / Ashby / Lever public APIs + HN "Who's Hiring" (Algolia) +
arbitrary user-supplied URLs + X.com via Grok. Filters via deterministic
L1 YAML rules + Gemini CLI L2 verdicts. SQLite store. Local web UI at
`localhost:3000`. Runs on the user's own machine using their Google AI Pro
quota via the Gemini CLI subprocess — no paid API keys, no cloud.

> **Status:** the canonical spec for the project lives at
> `C:\Users\Debayan\.claude\plans\review-this-codebase-want-scalable-badger.md`
> and `.claude/session/project-intent.md`. Code may not exist yet — paths
> below describe the planned layout in `src/`, `ui/`, `scripts/`, `data/`.

## Stack

- **Bun** (runtime, not Node) — native TS, `bun:sqlite`, builtin fetch.
- **Hono** (HTTP server, with SSE for run progress).
- **bun:sqlite** (DB at `data/data.db`).
- **cheerio** (HTML parsing), **Playwright** chromium (headless browser).
- **Gemini CLI** subprocess via `src/llm/gemini.ts` — Google AI Pro OAuth.
  Models: `gemini-2.5-pro` (HTML extract, verdict) and `gemini-2.5-flash`
  (NL→filter, lightweight extract).
- **Vite + React 19 + TailwindCSS 4 + shadcn/ui** for the SPA.
- **zod** for every Gemini output and adapter contract.
- TypeScript everywhere (strict). English-only UI.

## Architecture

- **Backend**: Hono on Bun serves `/api/*` routes (jobs, runs, criteria,
  sources, attachments, health) and the built UI from `ui/dist`. SSE drives
  live scan progress.
- **Source adapters** (`src/sources/*`) are async iterables conforming to
  `SourceAdapter` so the runner can stream `Job` objects into SQLite and
  emit progress without buffering. Registry at `src/sources/index.ts`.
- **Two-tier filter**: L1 deterministic YAML rules (`src/core/filter.ts`)
  runs inline during scan and kills ~80% with zero LLM cost. L2 Gemini
  verdict runs as a separate sequential pass over L1 survivors; verdicts
  are cached on `criteria_yaml + content_hash`.
- **Liveness** (`src/core/liveness.ts`) is deferred from scan time — runs
  only on shortlisted jobs, hybrid fetch-then-Playwright fallback.
- **Frontend** (`ui/src/`): three pages — `/settings`, `/run`, `/jobs`.

## Critical rules

1. **NEVER edit `data/`** — that's user data (`data.db`, `attachments/`,
   `browser-profile/`). Schema changes go through `src/db/migrate.ts`
   (idempotent — `CREATE ... IF NOT EXISTS`).
2. **NEVER call Gemini's HTTP API directly** — always via the
   `src/llm/gemini.ts` subprocess wrapper. The user has AI Pro auth on the
   CLI; there is no API key.
3. **Playwright is sequential.** One tab at a time. The Grok adapter and
   the liveness Playwright fallback must not run concurrently.
4. **All Gemini outputs go through zod** (`src/llm/schemas.ts`). On parse
   failure, retry once with a stricter "ONLY JSON, no prose, no markdown"
   addendum; on second failure, log and skip.
5. **Source adapters are async iterables** so the runner can stream.
6. **L1 runs inline during scan, no LLM.** L2 is a separate pass.
7. **Liveness only runs on shortlisted jobs**, not at scan time.
8. **Bind the local server to `localhost` only**, never `0.0.0.0`.
9. **HTML / scraped content fed to Gemini is an injection vector** — cap
   length (~16–32KB) and sanitize before substitution into prompts.
10. **Persisted browser profile** (`data/browser-profile/`) holds an X.com
    session — never log it, never share it, never check it in.
11. **Attachment uploads** (resume / cover-letter PDFs) need
    path-traversal-safe filename handling and content-type checks.

## Common commands

```bash
bun install
bunx playwright install chromium
npm i -g @google/gemini-cli && gemini auth   # one-time, AI Pro OAuth
bun run setup            # interactive first-run wizard
bun run healthcheck      # verify gemini CLI, Playwright, DB
bun run dev              # concurrently runs server (watch) + Vite dev
bun start                # build UI then serve on localhost:3000
bun run scan             # one-shot scan via CLI (no UI)
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

The ecosystem-review hook (set up in Phase 4) may also propose entries
when it spots patterns worth recording — a recurring correction across a
batch, a non-obvious gotcha just encountered. Claude surfaces those
proposals to you for approval before appending; the hook never
auto-edits this section.

<!-- Example: "API responses are camelCase on the wire, snake_case in
internal types — convert at the boundary in src/api/client.ts" -->

## Architectural notes — work with these, not against them

_None yet. The structural red-flag review at Phase 1 found no codebase
to review (lantern is pre-implementation as of 2026-05-09). When the team
accepts a non-obvious pattern as the way things are done here — something
Claude might otherwise try to "fix" — record it as 1–3 factual lines so
future sessions respect it._

## Skills available in this project

<!-- This section is auto-maintained by the ecosystem-review hook
     (set up in Phase 4). It lists the skills in .claude/skills/ and
     their purpose. -->

_No skills yet — populated in Phase 2 and Phase 3._

## Agents available in this project

<!-- Same as above — auto-maintained. -->

_No agents yet — populated in Phase 3._
