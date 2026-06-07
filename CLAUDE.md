# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**lantern** is a local-first, single-machine, **query-driven** job-search
harness. The search box is the sole entry point: the user types a role in plain
English ("senior backend engineer, remote in Europe, $120k+, no crypto") and
Claude (`nl-filter`) converts it into the structured criteria (title + location +
salary + seniority + exclusions) on every search. lantern then finds matching
jobs across per-company ATS boards (Greenhouse / Ashby / Lever / Recruitee /
SmartRecruiters / Workable / Personio public APIs, from a large maintained
default seed list) **and** keyword-global aggregators (RemoteOK / Arbeitnow /
Himalayas, where the keyword drives the query). Filters via deterministic L1
rules + LLM L2 verdicts; results are scoped to the current search and ranked by
fit. SQLite store. Local web UI at `localhost:3000`. UI-only — no user-facing CLI
surface. No headless browser.

Criteria is a **derived artifact**, not user-managed: the search endpoint
generates it from the query and writes the single `criteria` row (id=1) that the
runner reads. There is no criteria editor and no `/api/criteria` route.

## Stack

- **Bun** (runtime, not Node) — native TS, `bun:sqlite`, builtin fetch.
- **Hono** (HTTP server, with SSE for run progress).
- **bun:sqlite** (DB at `data/data.db`).
- **cheerio** (HTML / XML parsing). No Playwright, no headless browser.
- **LLM**: **Claude Code is the only provider**. Interface in
  `src/llm/provider.ts`, `llm` singleton in `src/llm/index.ts`, the single
  backend at `src/llm/providers/claude-code.ts` (spawns the `claude` CLI in
  headless `-p --output-format json --json-schema` mode over OAuth). Two tasks
  only: `verdict` (L2) and `nl-filter` (NL→filter). Per-task model overrides
  live in the `settings` KV table (`llm` row), editable via Settings UI. No
  provider switcher, no API keys, no baseUrl. See `src/llm/providers/claude-code.ts`
  for the `--bare`-auth gotcha (it breaks subscription OAuth — do not re-add it).
- **Vite + React 19 + TailwindCSS 4 + shadcn/ui** for the SPA.
- **zod** for every LLM output and adapter contract.
- TypeScript everywhere (strict). English-only UI.

## Architecture

- **Backend**: Hono on Bun serves `/api/*` routes (jobs, runs, sources,
  attachments, health, settings) and the built UI from `ui/dist`. SSE drives
  live scan progress.
- **Search flow**: `POST /api/runs/scan {query}` interprets the NL query via
  Claude (`nl-filter`) → writes the derived `criteria` row → invalidates prior
  L2 verdicts → runs the scan (which reads that criteria for L1/L2). The endpoint
  also returns the parsed criteria so the UI can show "here's what Lantern
  understood". A no-query body does a plain re-scan of the existing criteria.
  `GET /api/runs/recent-queries` backs the search-box history dropdown.
- **Source adapters** (`src/sources/*`) are async iterables conforming to
  `SourceAdapter` so the runner can stream `Job` objects into SQLite and
  emit progress without buffering. Registry at `src/sources/index.ts`. Two
  kinds: **per-company boards** (need a slug; ignore the keyword) and
  **keyword-global aggregators** (no slug; read the role keyword from
  `SourceContext.keywords`, populated by `scan.ts` from
  `criteria.title.positive`). Aggregators yield nothing when keywords are empty.
  Per-company adapters MUST populate `jd_text` (description) — L2 grades on it;
  five do (greenhouse via `?content=true`, lever/ashby/recruitee/personio from
  their existing payloads). SmartRecruiters + Workable JD are deferred TODOs.
- **Two-tier filter**: L1 deterministic rules (`src/core/filter.ts`) run inline
  during scan and kill ~80% with zero LLM cost — title (uniform across sources),
  location allow-list (+ remote), salary floor, company excludes. L2 LLM verdict
  runs as a separate **sequential** pass over L1 survivors **scoped to the run**
  (`last_run_id`); verdicts (+ denormalized `l2_score`/`l2_fit`) are stored per
  job and invalidated whenever criteria change. (L2 grades jobs in batches of 10
  per `claude` call — `L2_BATCH_SIZE` — to amortize each subprocess's ~15K
  uncacheable cold-start tokens; batches run sequentially.)
- **Run scoping & ranking**: `upsertJob` stamps `last_run_id` on every job a run
  surfaces; the Jobs API filters `?run=latest|<id>` and `?fit=1` and orders fit/L2
  views by `l2_score DESC`. So each search shows its own ranked result set.
- **Progress events** (`src/runner/progress.ts`): `scan_done` marks the L1→L2
  handoff and is **non-terminal** (the SSE stream stays open for L2 events);
  `l2_done` is terminal. `runs.finished_at` is set only after L2 (in `runFull`),
  never at L1-end — otherwise the run looks complete while L2 is still scoring.
- **Liveness** (`src/core/liveness.ts`) is deferred from scan time — runs
  only on shortlisted jobs, **fetch-only** (HTTP + cheerio; no browser fallback).
- **Dedup**: `findFuzzyDuplicate` (`src/runner/scan.ts`) prefilters on the
  indexed `company_norm` column (written by `upsertJob`) — do NOT reintroduce
  a full-table scan; at 300+ sources that is O(n²).
- **Frontend** (`ui/src/`): three pages — `/` (Search: NL hero + recent-query
  dropdown + "understood as" chips + live progress), `/jobs` (triage list +
  right-side detail panel), `/settings` (sources roster + LLM panel + health).

## Critical rules

1. **NEVER edit `data/`** — that's user data (`data.db`, `attachments/`).
   Schema changes go through `src/db/migrate.ts`
   (idempotent — `CREATE ... IF NOT EXISTS`).
2. **NEVER call the `claude` CLI (or any LLM) directly** — always via the `llm`
   singleton from `src/llm/index.ts`.
3. **All LLM outputs go through zod** (`src/llm/schemas.ts`). On parse
   failure, retry once with a stricter "ONLY JSON, no prose, no markdown"
   addendum; on second failure, log and skip. The provider's `call()`
   honors this contract.
4. **Source adapters are async iterables** so the runner can stream.
5. **L1 runs inline during scan, no LLM.** L2 is a separate pass.
6. **Liveness only runs on shortlisted jobs**, not at scan time, and is
   **fetch-only** — never add a headless browser anywhere in lantern.
7. **Bind the local server to `localhost` only**, never `0.0.0.0`.
8. **Scraped/aggregator content fed to LLMs is an injection vector** — cap
   length (the `verdict` prompt slices ~4KB; `htmlToText` caps ~8KB) and
   sanitize before substitution into prompts.
9. **Every source adapter must keep its SSRF guard** — `assertValidSlug` +
   `assertSafeHttpUrl` / host allowlist + `redirect:'error'` via
   `src/core/fetch.ts` (`fetchJson` / `fetchText`). Match the existing adapters.
10. **Attachment uploads** (resume / cover-letter PDFs) need
    path-traversal-safe filename handling and content-type checks.

## Common commands

```bash
bun install
bun run dev              # concurrently runs server (watch) + Vite dev
bun start                # build UI then serve on localhost:3000
bun test                 # bun's test runner
bun test path/to/file.test.ts             # single test file
bun test --test-name-pattern "..."        # single test by name
```

## Common tasks

- **Add a per-company board** (Greenhouse / Ashby / Lever / Recruitee /
  SmartRecruiters / Workable / Personio): add the slug to
  `src/config/seed-sources.yml`, restart. The seed list is the maintained
  default the user never edits; sources seed lazily on the first scan.
- **Add a new source type**: implement `SourceAdapter` in `src/sources/`,
  register in `src/sources/index.ts`, add the type to the `SourceType` union in
  `src/core/job.ts`, the `sources.type` CHECK in `src/db/schema.sql`,
  `SOURCE_TYPES` (+ `AGGREGATOR_TYPES` if keyword-global) in
  `src/routes/sources.ts`, and the UI mirrors in `ui/src/lib/api.ts` +
  `ui/src/pages/Settings.tsx`. Keep the SSRF guard (Critical rule §9). Populate
  `jd_text` (run HTML through `aggregator-util.htmlToText`) so L2 has a
  description to grade.
- **Change a prompt**: edit `src/llm/prompts.ts`. Outputs validated by
  `src/llm/schemas.ts` — update both together.
- **Schema change**: add idempotent SQL to `src/db/schema.sql`
  (`CREATE ... IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN` guarded). Keep
  comments **semicolon-free** — `migrate.ts` splits on `;` before stripping
  comments, so a `;` in a comment breaks init. Indexes on
  migration-added columns go in `migrate.ts`, not `schema.sql`.
- **Run anything that hits the LLM**: the `claude` CLI must be on `PATH`. On
  this machine it ships only inside the VSCode extension's `native-binary/`
  dir — prepend that to `PATH` first.

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
- Scan progress has two phases. `runScan` emits `scan_done` (NON-terminal) at the
  L1→L2 handoff; the SSE stream + `useSSE` hook stay open and only close on
  `l2_done`/`done`/`error`. `runs.finished_at` is set after L2 in `runFull`, never
  at L1-end. Emitting `done` or setting `finished_at` early makes the UI look
  complete / stuck while L2 is still scoring (the original bug).
- Per-company adapters must map the description into `jd_text`, or L2 grades the
  job on title alone. The body is usually already in the fetched payload
  (lever `descriptionPlain`, ashby `descriptionPlain`/`descriptionHtml`, recruitee
  `description`, personio `<jobDescription>`); greenhouse needs `?content=true`
  and its `content` is entity-encoded HTML → `htmlToText(htmlToText(...))`.
- Criteria is derived from the NL query, not user-edited. `POST /api/runs/scan`
  runs `nl-filter` → writes the `criteria` id=1 row → invalidates L2 verdicts
  (`l2_verdict_json`/`l2_score`/`l2_fit`). There is no `/api/criteria` route and no
  Settings criteria editor — don't reintroduce them.
- L2 grades jobs in batches (`L2_BATCH_SIZE=10`) per `claude` call (`runL2Pass`,
  `batchVerdictPrompt`, `BatchVerdictShape`) to amortize the ~15K system/tool
  tokens each subprocess cold-starts with and can't cache across invocations.
  Batches are sequential. Don't revert to per-job L2 calls.
- Importing `src/llm/index.ts` (and anything that transitively pulls in
  `src/db/client.ts`) runs `createDb()` and all migrations at module
  load. Tests and standalone tools that import the `llm` singleton pay
  filesystem cost up-front; if they don't need the DB, stub it.
- Playwright / any headless browser is banned everywhere in lantern (removed
  in Phase 8). Liveness is fetch-only; `src/runner/liveness.test.ts` asserts
  Playwright is not imported anywhere.
- Claude Code is the only LLM provider; there is no provider switcher or
  `constructionKey()` cache (removed in Phase 1 — the provider takes no
  construction inputs, so a single lazy instance is reused). Per-task model
  overrides live in the `settings` KV `llm` row and are re-read every `call()`.
- `claude --bare` breaks subscription / OAuth auth (it reads only
  `ANTHROPIC_API_KEY`). The provider must NOT use it; it isolates context via
  `--system-prompt` + `--setting-sources ''` + `--strict-mcp-config
  --mcp-config '{"mcpServers":{}}'` + a throwaway cwd instead. See
  `src/llm/providers/claude-code.ts`.
- `migrate.ts` splits `schema.sql` on `;` before stripping comments, so any
  `;` inside a SQL comment breaks fresh-DB init. Keep schema.sql comments
  semicolon-free. Migrations are not test-covered (no test imports
  `db/client`) — verify migration changes by running `runMigrations` on a
  `:memory:` DB.

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
