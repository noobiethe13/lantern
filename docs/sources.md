# Sources

A source is one place Lantern fetches jobs from. Every source is a public HTTP
API or feed, so there is no general web scraping in the default path. Adapters live
in [`src/sources/`](../src/sources) and are registered in
[`src/sources/index.ts`](../src/sources/index.ts).

## Two kinds of source

Sources come in two shapes, and the difference drives how a search reaches them.

| | Per-company board | Keyword aggregator |
|---|---|---|
| Needs a slug | Yes (the company's tenant) | No |
| Uses the search keyword | No, returns the whole board | Yes, the keyword drives the query |
| Example | `greenhouse:airbnb` | `remoteok` |
| Yields when keywords are empty | Still yields | Yields nothing |

Per-company boards return every open role for one employer; the criteria filter
narrows them afterward. Aggregators are keyword-global: they read the role terms
from the search and query the provider directly, so they contribute nothing to a
search with no title keywords.

## The adapter contract

An adapter is an async iterable so the runner can stream jobs into SQLite without
buffering:

```ts
interface SourceAdapter {
  fetch(ctx: SourceContext): AsyncIterable<Job>;
}
```

`SourceContext` carries what the adapter needs from the current search: the source
config, the criteria-derived `keywords` and `locations`, whether remote is
required, a progress callback, and an abort signal.

Four rules are load-bearing (the full list is in
[`.claude/rules/source-adapters.md`](../.claude/rules/source-adapters.md)):

1. **Keep the SSRF guard.** Validate the slug, build the exact host, and pass it
   as an allowlist. Never fetch a user-supplied URL unguarded.
2. **Stream, don't buffer.** Yield `Job` objects; do not return an array.
3. **Populate `jd_text`.** The grader reads the description. If an adapter cannot
   fetch one, it leaves `jd_text` absent (NULL) rather than empty. An empty
   string reads as "no description" to the ghost scorer.
4. **Validate every parsed shape** against the contract, and keep the parse
   function exported and unit-tested next to the adapter.

### How a per-company fetch stays safe

```mermaid
sequenceDiagram
    participant R as Runner
    participant A as Adapter
    participant F as fetch layer
    participant B as Board API

    R->>A: fetch(ctx)
    A->>A: assertValidSlug(identifier)
    A->>A: build exact host + URL
    A->>F: fetchJson(url, allowedHosts:[host])
    F->>F: assertSafeHttpUrl · redirect:'error'
    F->>B: GET (timeout + retry)
    B-->>F: JSON
    F-->>A: parsed body
    loop each posting
        A->>A: validate shape → Job (with jd_text)
        A-->>R: yield Job
    end
```

The fetch layer ([`src/core/fetch.ts`](../src/core/fetch.ts)) centralizes the
guard. `fetchJson` / `fetchText` reject unsafe hosts, refuse redirects, and carry
timeout and retry knobs (retrying network errors, 429, and 5xx while respecting
`Retry-After`; guard rejections are never retried).

## The catalog

Per-company boards (each needs a slug in [`seed-sources.yml`](../src/config/seed-sources.yml)):

| Type | Provider | Salary | Description |
|---|---|:---:|:---:|
| `greenhouse` | Greenhouse | sometimes | via `?content=true` |
| `ashby` | Ashby | ✓ | structured comp |
| `lever` | Lever | ✓ | annual ranges |
| `recruitee` | Recruitee | — | ✓ |
| `smartrecruiters` | SmartRecruiters | — | deferred |
| `workable` | Workable | — | deferred |
| `personio` | Personio | — | ✓ |
| `bamboohr` | BambooHR | — | per-job detail |
| `workday` | Workday | — | composite tenant+site |

Keyword aggregators:

| Type | Provider | Auth | Default |
|---|---|---|:---:|
| `remoteok` | RemoteOK | keyless | on |
| `arbeitnow` | Arbeitnow | keyless | on |
| `himalayas` | Himalayas | keyless | on |
| `jobicy` | Jobicy (remote) | keyless | on |
| `linkedin` | LinkedIn guest | keyless, gated | off |
| `google_jobs` | Google Jobs (SerpAPI) | API key | off |

Lantern ships around 320 seeded per-company boards, weighted toward Greenhouse
and Ashby, so a fresh install has coverage on the first scan. The seed list is a
maintained default (you are not expected to edit it), and boards seed lazily the
first time you run a scan.

Two sources are held back by default. `linkedin` uses an unofficial keyless guest
endpoint (gray-area, aggressively rate-limited), and `google_jobs` needs your own
SerpAPI key. Both are enabled from Settings.

## Adding a board or a type

- **A new company on an existing type** is a one-line entry in
  `seed-sources.yml`, then a restart.
- **A new source type** touches several mirrors: the union in `src/core/job.ts`,
  the CHECK in `schema.sql` plus a rebuild migration, the type lists in
  `src/routes/sources.ts`, the registry in `src/sources/index.ts`, and the UI
  mirrors. See [development.md](development.md) for the full checklist.

For pasting a careers URL in the UI, `detectBoard` recognizes the common board
patterns and derives the type and slug from the URL.
