# Lantern

A local-first, single-machine, **query-driven** job-search harness. You type what
you want in plain English — "senior backend engineer, remote in Europe, $120k+,
no crypto" — and Lantern interprets it, finds matching jobs, filters them
deterministically, scores the survivors with an LLM, and serves the ranked
shortlist in a local web UI at `localhost:3000`.

Everything runs on your machine. There is no account, no hosted backend, and no
user-facing CLI — the web UI is the whole surface. The search box is the only way
in; it even shows you "here's what Lantern understood" so the interpretation is
transparent.

## How it finds jobs

Your plain-English search is interpreted by Claude into structured criteria
(title, location, salary, seniority, exclusions). Then two source tiers run:

- **Per-company ATS boards** (precision tier) — Greenhouse, Ashby, Lever,
  Recruitee, SmartRecruiters, Workable, Personio. Lantern ships a large
  maintained default seed list (~320 boards) you never have to edit; your
  criteria filter their results.
- **Keyword-global aggregators** (recall tier) — RemoteOK, Arbeitnow, Himalayas.
  No per-company config; the role keyword *drives the query* against their
  search APIs.

There is no headless browser and no general web scraping — every source is a
no-auth public HTTP API or feed, fetched behind an SSRF guard.

## How it filters

1. **L1 — deterministic rules** (`src/core/filter.ts`) run inline during the scan
   and kill ~80% of jobs at zero LLM cost: title, location allow-list, salary
   floor, and company excludes, applied uniformly to every source.
2. **L2 — LLM verdict** runs as a separate pass over L1 survivors, scoring each
   against the job description. The only LLM provider is **Claude Code** (the
   `claude` CLI in headless mode over your Anthropic OAuth login); verdicts are
   cached per job and invalidated when your search changes.
3. Results are **scoped to the current search and ranked by fit**. **Liveness**
   runs only on shortlisted jobs, fetch-only, to drop dead links.

## Stack

- **[Bun](https://bun.sh)** runtime (native TS, `bun:sqlite`, builtin fetch)
- **[Hono](https://hono.dev)** HTTP server with SSE for live scan progress
- **bun:sqlite** store at `data/data.db`
- **cheerio** for HTML/XML parsing
- **Vite + React 19 + TailwindCSS 4** for the single-page UI
- **zod** validates every LLM output and adapter contract

## Setup

Prerequisites: [Bun](https://bun.sh) and the
[Claude Code](https://code.claude.com/docs/en/overview) CLI on your `PATH`
(Lantern spawns it for L2 verdicts and natural-language → filter generation).

```bash
bun install
bun run dev    # server (watch) + Vite dev server
# or
bun start      # build the UI, then serve on localhost:3000
```

Then open `localhost:3000`, type a role on the Search page, and run a scan.
Sources seed lazily on your first scan.

```bash
bun test                                  # run the test suite
bun test path/to/file.test.ts             # a single file
```

## Architecture

See [CLAUDE.md](CLAUDE.md) for the full architecture, critical rules, and
common tasks, and [docs/adr/](docs/adr/) for design records. In brief:

- **Source adapters** (`src/sources/*`) are async iterables so the runner
  streams jobs into SQLite without buffering. Registry at
  `src/sources/index.ts`.
- **Two-tier filter** lives in `src/core/filter.ts` (L1) and the LLM provider at
  `src/llm/` (L2).
- **Frontend** (`ui/src/`) has three pages: `/` (Search), `/jobs` (triage),
  `/settings`.

`data/` holds your jobs, attachments, and settings — it is never edited by hand;
all schema changes go through the idempotent `src/db/migrate.ts`.
