---
paths:
  - src/sources/**
---

# Source adapter invariants

Load-bearing rules for `src/sources/*`. Match the existing adapters; don't
regress these.

- **SSRF guard is mandatory.** Per-company adapters call `assertValidSlug`, build
  the exact host, and pass `allowedHosts:[host]` to `fetchJson`/`fetchText`
  (`src/core/fetch.ts`, which sets `redirect:'error'`). Never fetch a
  user/offer-supplied URL without host-allowlisting it.
- **Pass the abort signal.** Per-company `fetch(ctx)` calls give `fetchJson`/`fetchText`
  `signal: ctx.abortSignal`, so a source deadline or the background refresher's abort cancels the
  request and its retry sleeps instead of only being checked between pages.
- **Adapters are async iterables** (`fetch(ctx): AsyncIterable<Job>`) so the
  runner streams into SQLite without buffering. Don't return arrays.
- **Populate `jd_text`.** L2 grades the job on its description; an empty `jd_text`
  means Claude scores on the title alone. The body is usually already in the
  payload you fetch — map it, running HTML through `aggregator-util.htmlToText`
  (it caps length). Greenhouse needs `?content=true` and its `content` is
  entity-encoded HTML → `htmlToText(htmlToText(content))`. When the list payload
  has none (LinkedIn, Rippling, SmartRecruiters, Workable, Workday), omit `jd_text`
  and implement `enrich()` — never prefetch per job inside `fetch()`.
- **Two kinds of source.** Per-company boards need a slug and ignore the keyword.
  Keyword-global aggregators have no slug, read `ctx.keywords`, and yield nothing
  when keywords are empty. Aggregator `identifier` is a fixed sentinel.
- **Adding a type** touches many mirrors — see CLAUDE.md "Add a new source type".
- Validate every parsed shape against the adapter contract; keep parse functions
  exported + unit-tested (mirror `*.test.ts`).
