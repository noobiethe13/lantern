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
surface. No headless browser in the default fetch path (an optional, lazy,
deterministic browser tier handles a few opt-in features — see Critical rule §6).

Criteria is a **derived artifact**, not user-managed: the search endpoint
generates it from the query and writes the single `criteria` row (id=1) that the
runner reads. There is no criteria editor and no `/api/criteria` route.

## Stack

- **Bun** (runtime, not Node) — native TS, `bun:sqlite`, builtin fetch.
- **Hono** (HTTP server, with SSE for run progress).
- **bun:sqlite** (DB at `data/data.db`).
- **cheerio** (HTML / XML parsing). No browser in the default path; an
  **optional, lazy, deterministic** browser tier (`src/runner/browser.ts`,
  Patchright, dynamic-imported, absent by default) serves a few opt-in features —
  never bulk fetch, never LLM-driven (§6).
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
- **Search flow**: `POST /api/runs/scan {query}` takes the scan lock, then
  interprets the NL query via Claude (`nl-filter`) → writes the derived `criteria`
  row → invalidates prior L2 verdicts if the derived criteria changed → runs the scan (which reads that criteria for L1/L2). The endpoint
  also returns the parsed criteria so the UI can show "here's what Lantern
  understood". A no-query body does a plain re-scan of the existing criteria.
  `GET /api/runs/recent-queries` backs the search-box history dropdown.
- **Source adapters** (`src/sources/*`) are async iterables conforming to
  `SourceAdapter` so the runner can stream `Job` objects into SQLite and
  emit progress without buffering. Registry at `src/sources/index.ts`. Two
  kinds: **per-company boards** (need a slug; ignore the keyword) and
  **keyword-global aggregators** (no slug; read the role keyword from
  `SourceContext.keywords`, populated by `scan.ts` from a normalized
  `criteria.title.positive`). Aggregators yield nothing when keywords are empty.
  Per-company adapters MUST populate `jd_text` (description) — L2 grades on it;
  six do in `fetch()` (greenhouse via `?content=true`, lever/ashby/recruitee/personio
  from their existing payloads, bamboohr via per-job detail). An adapter may
  implement optional `enrich()` for per-job detail — LinkedIn, Rippling,
  SmartRecruiters (+ search), Workable and Workday fetch their JD this way: the
  runner calls it only for L1 survivors without `jd_text`, sequentially, ≤40 per
  source per run. Each source
  runs under its own abort signal + 8-min deadline (`last_status='timeout'`), and
  every yielded job is validated with `JobShape` (invalid ones skipped + counted).
- **Board cache** (`src/runner/board-cache.ts`): per-company boards are
  query-independent, so a board whose `sources.last_ok_fetch_at` (start of its last
  complete successful fetch) is within the TTL (settings KV `board_cache`, default 6h,
  0 = off) is NOT fetched. The scan re-runs L1 on its stored jobs that the last fetch saw
  (`board_sightings.seen_at >= last_ok_fetch_at` for that board) and stamps `last_run_id` + the verdict on each, like a
  fetched job. Aggregators, stale/never-fetched boards and query-dependent fetches (Workable's `?query=`) stay live; failed, partial or
  timed-out fetches never advance the timestamp. Every `l1Filter` input must be a
  persisted `jobs` column (`employment_type` is one now).
- **Background board refresher** (`src/runner/board-refresher.ts`): one loop started
  from `server.ts` (not under `bun test`) re-fetches stale enabled per-company boards,
  3 at a time with per-host pacing, so searches hit the board cache. Refresh mode =
  `upsertJob(..., runId = null)`: same content/sighting/`last_ok_fetch_at` semantics as
  a live fetch, but no `last_run_id`, no progress events, L1 columns untouched (the
  scan's cache phase grades them). It never takes the scan lock: it pauses while one is
  held, aborts in-flight fetches, and writes boards in lock-checked transactions. Toggle:
  settings KV `board_refresh`, `/api/settings/board-refresh`.
- **Two-tier filter**: L1 deterministic rules (`src/core/filter.ts`) run inline
  during scan and kill ~80% with zero LLM cost — whole-word term matching (never
  substring) for title (uniform across sources), location (gazetteer + remote
  eligibility), salary floor, company excludes, a seniority gate (drops senior+
  titles only when criteria restricts to junior/mid), and a freshness gate — see
  `docs/filtering-and-ranking.md`. **Semantic rescue** (`src/runner/semantic-rescue.ts`)
  runs between the scan and L2: jobs whose ONLY L1 failure was the missing title
  keyword are promoted (`l1_rescued=1`, ≤40/run) when their embedding is close to
  the centroid of the run's L1 survivors (query anchor if <5). L2 stays the judge. L2 LLM verdict
  runs as a separate **sequential** pass over L1 survivors **scoped to the run**
  (`last_run_id`); verdicts (+ denormalized `l2_score`/`l2_fit`) are stored per
  job and invalidated whenever criteria change. (L2 grades jobs in batches of 20
  per `claude` call — `L2_BATCH_SIZE` — to amortize each subprocess's large
  uncacheable fixed per-spawn cost; batches run sequentially.)
- **Run scoping & ranking**: `upsertJob` stamps `last_run_id` on every job a run
  surfaces; the Jobs API filters `?run=latest|<id>` and `?fit=1` and orders fit/L2
  views by fit tier then `l2_score DESC` plus a bounded (±0.1) learned-taste delta from
  shortlisted/hidden jobs (ranking only, `docs/intelligence.md` §6). So each search shows its own ranked result set.
- **Progress events** (`src/runner/progress.ts`): `rescue_start`/`rescue_done`
  (semantic rescue, between `scan_done` and `l2_start`) are non-terminal too.
  `scan_done` marks the L1→L2
  handoff and is **non-terminal** (the SSE stream stays open for L2 events);
  `l2_done` (or `error`) is terminal. `runs.finished_at` is set only after L2
  (`runL2Pass` writes it right before `l2_done`; `runFull`'s catch before `error`),
  never at L1-end — otherwise the run looks complete while L2 is still scoring.
- **Liveness** (`src/core/liveness.ts`) is deferred from scan time — runs
  only on shortlisted jobs, **fetch-first** (HTTP + cheerio, SSRF-guarded on every
  redirect hop); an `uncertain` result may fall back to the optional deterministic
  browser tier (§6).
- **Dedup**: `findFuzzyDuplicate` (`src/runner/scan.ts`) prefilters on the
  indexed `company_norm` column (written by `upsertJob`) — do NOT reintroduce
  a full-table scan; at 300+ sources that is O(n²). It folds only via
  `shouldFold` (same role incl. level tokens + compatible location). A re-scan of a
  known URL whose `content_hash` changed refreshes the content and clears that
  job's L2 verdict + embedding (triage fields, `posted_at`, `first_seen` kept).
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
6. **Liveness only runs on shortlisted jobs**, not at scan time. **No headless
   browser in the default/hot scan path, and no LLM-driven browsing ever.** The
   deterministic browser tier (`src/runner/browser.ts`) is the sole exception: an
   **optional, lazy, dynamic-imported** engine (Patchright; absent by default)
   used deterministically (navigate + fixed selectors, zero LLM tokens) for opt-in
   features only — shortlisted-job SPA-liveness fallback, paste-a-URL extraction,
   and opt-in browser-driven sources. It keeps the SSRF +
   injection caps and tears down ephemerally. `src/runner/liveness.test.ts`
   enforces that the engine is named only in that one seam and loaded only via
   dynamic `import()`. See `docs/browser-tier.md` for the rationale.
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
- **Refresh discovered boards**: `bun scripts/discover-boards.ts` (resumable,
  see `docs/sources.md`) regenerates `src/config/discovered-sources.json`;
  those boards seed disabled with `sources.origin='discovered'`, hidden from the
  roster, and are bulk-toggled by the Settings switch.
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
  `l2_done`/`done`/`error`. `runs.finished_at` is set after L2 (by `runL2Pass`,
  before it emits `l2_done`), never at L1-end. Emitting `done` or setting `finished_at` early makes the UI look
  complete / stuck while L2 is still scoring (the original bug).
- Per-company adapters must map the description into `jd_text`, or L2 grades the
  job on title alone. The body is usually already in the fetched payload
  (lever `descriptionPlain` + `lists[]` + `additionalPlain` — requirements /
  responsibilities live only in `lists[]`, ashby `descriptionPlain`/`descriptionHtml`, recruitee
  `description`, personio `<jobDescription>`); greenhouse needs `?content=true`
  and its `content` is entity-encoded HTML → `htmlToText(htmlToText(...))`.
- Criteria is derived from the NL query, not user-edited. `POST /api/runs/scan`
  runs `nl-filter` → writes the `criteria` id=1 row → invalidates L2 verdicts
  (`l2_verdict_json`/`l2_score`/`l2_fit`) when the derived YAML changed (an
  identical query skips nl-filter and keeps verdicts). There is no `/api/criteria` route and no
  Settings criteria editor — don't reintroduce them.
- L2 grades jobs in batches (`L2_BATCH_SIZE=20`) per `claude` call (`runL2Pass`,
  `batchVerdictPrompt`, `BatchVerdictShape`) to amortize the fixed per-spawn
  cost each subprocess cold-starts with. Batches are sequential. Don't revert to
  per-job L2 calls.
- The provider spawns `claude` with `--tools ''` (drops built-in tool defs,
  ~27K -> ~1.5K input tokens/spawn) and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`
  (skips a ~2.5K-token background Haiku call). Default models are the CLI
  aliases `sonnet`/`haiku` so the newest model the installed CLI knows is used
  automatically — don't pin full model ids in `TASK_MODELS`.
- Importing `src/llm/index.ts` (and anything that transitively pulls in
  `src/db/client.ts`) runs `createDb()` and all migrations at module
  load. Tests and standalone tools that import the `llm` singleton pay
  filesystem cost up-front; if they don't need the DB, stub it.
- The browser ban is **scoped, not absolute**. An earlier headless browser was
  removed because it served a since-deleted LLM-HTML-extraction strategy — the
  binding constraint was deterministic/fetch-only identity, not the browser per se.
  The deterministic browser tier (`src/runner/browser.ts`) is an
  optional, lazy, dynamic-imported engine (absent by default, zero LLM tokens),
  allowed ONLY for opt-in liveness-fallback / paste-a-URL / browser-driven sources.
  `src/runner/liveness.test.ts` now asserts the engine is named only in that seam
  and loaded only via dynamic `import()` — NOT that no browser exists. Still banned:
  a browser in the default/hot fetch path, a static engine import anywhere, and any
  LLM-driven browsing (screenshots/DOM → model).
- The board cache reads L1 inputs from `jobs` columns, so a new `l1Filter` input needs a
  persisted column (schema.sql + guarded migrate.ts) or cached and live L1 drift apart.
  `last_ok_fetch_at` is set only on a live `scanOne` success path, from the fetch START
  taken before `adapter.fetch`. Cached-board stamping is write-bound (wide rows rewrite
  ~60us each), so keep per-row work out of it.
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
- Ashby salary lives in `job.compensation.summaryComponents[]` (find the
  `compensationType:'Salary'` entry with `interval:'1 YEAR'`, read
  `minValue`/`maxValue`/`currencyCode`), NOT `job.compensationTierSummary`
  (that's a formatted display string). Needs `?includeCompensation=true`.
- Job salary is native-currency: amounts in `salary_min_usd`/`salary_max_usd`
  (the `_usd` suffix is legacy) are tagged by `salary_currency`. L1's salary
  floor only fires when the job and criteria currencies are both known and
  equal — mismatched/unknown currency passes and defers to L2 (no FX in lantern).
- `fetchJson`/`fetchText` take `timeoutMs` and `retries` in `FetchOpts` (internal
  retry loop: network errors + 429 + 5xx, `Retry-After`-aware; SSRF guard
  rejections never retried). Adapters needing resilience use these knobs — don't
  add a custom retry wrapper. Non-OK responses throw `HttpStatusError` carrying
  `status` and a ≤300-char body snippet.
- Liveness strips `nav, header, footer, script, style, noscript, template` before
  collecting apply controls AND body text (nav "Apply now" links were a
  false-active vector, hidden i18n strings a false-expired one). Any non-2xx
  classifies `uncertain`, never expired. Thin content on a SPA
  host (`SPA_HOSTS` in `core/liveness.ts`) classifies `uncertain`, never closed.
- Adapters whose listing carries no description (LinkedIn guest cards, Workday cxs
  listing, SmartRecruiters/Workable list endpoints — filled by `enrich()`) must OMIT `jd_text` (leave it
  absent → NULL), never set `''`. `core/legitimacy.ts` treats null jd_text as an
  adapter gap (no flag) but a present-but-empty string as "no job description"
  (a ghost flag) — `''` would wrongly flag every such job.
- `sources.type` is a CHECK constraint baked into `CREATE TABLE`. SQLite has no
  ALTER CHECK, so adding a board type needs BOTH the schema.sql CHECK (fresh DBs)
  AND a table-rebuild migration in `migrate.ts` (existing DBs) — see
  `migrateSourceTypeCheck` (`SOURCE_TYPE_CHECK` kept in sync with schema.sql;
  rebuild runs with `foreign_keys=OFF` around a txn, preserves row ids so
  `jobs.source_id` stays valid; no-op when the stored DDL already has every type).
- `fetchJson`/`fetchText` take `method`/`body` in `FetchOpts` (Workday's cxs feed
  is a POST; object bodies are JSON-encoded with a default Content-Type). The
  SSRF guard + `redirect:'error'` still apply — don't hand-roll a POST `fetch`.
- Gated job boards: verify the endpoint LIVE before building. Many are far less
  accessible than they first look — some need a bundled scraped secret, others sit
  behind a WAF/recaptcha. Bundling a third-party secret or needing WAF/TLS evasion
  is out of scope for an honest fetch-only adapter; that belongs to the optional
  browser tier. The LinkedIn guest endpoint (`seeMoreJobPostings/search`) is the
  rare keyless one. Workday/BambooHR are clean public ATS APIs (per-company, not
  gated). Shared politeness helpers for the gated adapters live in
  `src/sources/gated-util.ts`.
- Workday sources carry a composite identity: tenant slug (`identifier`) +
  datacenter + career-site name in `config_json` (`{dc, site}` or `{host, site}`),
  because the single slug can't hold a site name with underscores. seed-sources.yml
  entries can include a `config:` object (seedSources serialises it to config_json).
- bun's `mock.module` is process-global, last-registration-wins — not per-file.
  Tests share ONE harness (`src/test-harness.ts`: mocked `db/client` + `llm/index`
  over a shared `:memory:` db; call `resetDb()` in `beforeEach`). Never add another
  `mock.module` for those modules; it silently repoints every other file's mocks.
- Workday's cxs feed reports `total` only on page 0 (later pages say 0) — capture
  it from the first page, don't stop paginating on a later page's `total`.
- SmartRecruiters' public posting URL is `jobs.smartrecruiters.com/{company.identifier}/{postingId}`
  — no `/postings/` segment (the `ref` API path copied onto the public host 404s).
- `POST /api/runs/scan` acquires the scan lock BEFORE the nl-filter call (and
  releases it on every early exit); `runFull` then owns and releases it. Seed sync
  is one-directional: a per-company seed entry with `enabled: false` (a retired
  slug) disables the DB row; aggregators' `enabled: false` means opt-in and is left alone.
- `Bun.spawn` resolves a bare command against the PATH snapshot from Bun's own
  startup unless `env` is passed — the claude provider passes `env: process.env`
  so a CLI installed after the server started is found.

- The scan's live pool is per-host paced (`runner/host-pacer.ts`, `runHostPool`) by one
  process-wide `hostPacer` shared with the background refresher: boards group by vendor
  (`hostKey`), with an in-flight cap + jittered start gap per group (enrich calls too) and a rest
  after a 429 (<=60s waited out, longer skips the queue). A 429'd or skipped per-company source is
  `last_status='rate-limited'`, served from its older stored jobs, and reported as one aggregated
  `errors_json` entry per host. Don't go back to a plain wide pool: 15k discovered boards flood
  Workable/Recruitee and every board 429s.

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
