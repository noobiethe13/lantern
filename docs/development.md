# Development

How the code is laid out, how to run it, and how to extend it.

## Prerequisites

- [Bun](https://bun.sh) 1.1+
- The [Claude Code](https://claude.com/claude-code) CLI on your `PATH`, signed in,
  for anything that parses a search or grades jobs.

## Commands

```bash
bun install
bun run dev              # server (watch) + Vite dev server, hot reload
bun start                # build the UI, then serve on localhost:3000
bun test                 # the test suite
bun test path/to/file.test.ts             # a single file
bun test --test-name-pattern "..."        # a single test by name
bunx tsc --noEmit        # type-check (covers the UI too)
```

## Project layout

```
src/
  server.ts            Hono app, route wiring, static SPA, localhost bind
  routes/              /api/* handlers (jobs, sources, runs, settings, …)
  runner/              scan orchestration, L2, the deterministic passes, browser tier
  core/                pure logic: filter, dedup, legitimacy, embed, liveness,
                       fetch/SSRF, ranking metrics, résumé, pdf, pool
  sources/             one adapter per board type + the registry
  llm/                 the provider, prompts, zod schemas, the singleton
  db/                  schema.sql, migrations, the client singleton
  config/              seed-sources.yml (the default board list)
ui/src/                React SPA: pages/ (Search, Jobs, Settings), components/, lib/
docs/                  this documentation
```

## Testing conventions

- **Core logic is pure and unit-tested.** Filter, dedup, legitimacy, embedding
  math, and the ranking metrics have no database dependency, so their tests run
  without touching disk.
- **Parse functions are exported and tested** next to each adapter (`*.test.ts`).
- **Migrations are not test-covered.** Verify a schema change by running the
  migrations against an in-memory database in three states: fresh, legacy, and
  idempotent (running twice is a no-op). See [data-model.md](data-model.md).
- **The UI cannot be verified headlessly.** Type-checking and the Vite build catch
  contract and compile errors; visual changes need a real browser.

Importing the `llm` singleton (or anything that pulls in the database client) runs
migrations at module load. Standalone tools and tests that do not need the
database should avoid that import.

## Adding a source

Adding a company to an existing board type is a one-line entry in
[`src/config/seed-sources.yml`](../src/config/seed-sources.yml), then a restart.

Adding a new source **type** touches several mirrors, so keep them in sync:

1. Implement the adapter in `src/sources/` (async iterable, SSRF guard, populate
   `jd_text`) and register it in `src/sources/index.ts`.
2. Add the type to the `SourceType` union in `src/core/job.ts`.
3. Add it to the `sources.type` CHECK in `src/db/schema.sql` **and** the
   table-rebuild migration in `src/db/migrate.ts` (SQLite cannot alter a CHECK).
4. Add it to the type lists in `src/routes/sources.ts` (and the aggregator list if
   it is keyword-global).
5. Mirror it in the UI (`ui/src/lib/api.ts`, `ui/src/pages/Settings.tsx`).

The adapter rules are in
[`.claude/rules/source-adapters.md`](../.claude/rules/source-adapters.md), and
[sources.md](sources.md) has the wider picture.

## The invariants

Some rules are load-bearing and a change that breaks them will be reverted. They
live in [`CLAUDE.md`](../CLAUDE.md) under "Critical rules": local-only bind, the
`llm` singleton as the sole model entry point, zod on every model output, no
browser in the default fetch path, the SSRF guard on every adapter, and never
editing `data/` by hand. Skim them before a substantial change.

## AI-assisted workflow

This repository is set up for [Claude Code](https://claude.com/claude-code) with
project skills and specialist agents. If you work that way, see
[CONTRIBUTING-AI.md](../CONTRIBUTING-AI.md).
