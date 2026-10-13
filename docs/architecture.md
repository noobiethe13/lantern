# Architecture

Lantern is a single Bun process. It serves an HTTP API and a built React SPA,
runs scans against a set of job boards, and stores everything in a local SQLite
file. There is no separate worker, queue, or database server.

## Components

```mermaid
flowchart LR
    subgraph Browser["Browser · localhost:3000"]
        UI["React SPA<br/>Search · Jobs · Settings"]
    end

    subgraph Server["Bun process"]
        API["Hono HTTP API<br/>/api/* + SSE"]
        RUN["Runner<br/>scan · L2 · passes"]
        CORE["Core<br/>filter · dedup · legitimacy<br/>embed · liveness"]
        ADP["Source adapters<br/>~320 boards"]
        LLM["LLM provider<br/>Claude Code CLI"]
    end

    DB[("SQLite<br/>data/data.db")]
    CLI["claude CLI<br/>(subprocess)"]
    BOARDS["Public job-board APIs"]

    UI <-->|"REST + Server-Sent Events"| API
    API --> RUN
    RUN --> CORE
    RUN --> ADP
    RUN --> LLM
    ADP -->|"fetch, SSRF-guarded"| BOARDS
    LLM -->|"headless, over OAuth"| CLI
    API <--> DB
    RUN <--> DB
```

The pieces:

- **HTTP API** (`src/server.ts`, `src/routes/*`) is a Hono app on Bun. It exposes
  `/api/*` routes, streams scan progress over Server-Sent Events, and serves the
  built SPA from `ui/dist`. It binds to `localhost` only, and every `/api/*`
  request must carry a localhost `Host` header (a DNS-rebinding defence);
  state-changing requests additionally reject a foreign `Origin` or a
  `Sec-Fetch-Site: cross-site` request. Unknown `/api/*` paths return a JSON 404,
  never the SPA shell.
- **Runner** (`src/runner/*`) orchestrates a scan: fetch, filter, the
  deterministic passes, and language-model grading. Progress is published on an
  in-process event bus.
- **Core** (`src/core/*`) is the pure logic: filtering, deduplication, the ghost
  scorer, embeddings, liveness classification, and the fetch/SSRF layer. Most of
  it has no database dependency, which keeps it unit-testable.
- **Source adapters** (`src/sources/*`), one per board type, each an async
  iterable that streams `Job` objects.
- **LLM provider** (`src/llm/*`) is the single integration point for the language
  model. It spawns the Claude Code CLI in headless mode.
- **Store** (`src/db/*`) is a `bun:sqlite` database with an idempotent schema and
  migrations.

## The scan lifecycle

A search runs through the pipeline below. The two language-model steps (parsing
the query and grading survivors) are the only work that leaves the machine, and
both go to your Claude Code session.

```mermaid
sequenceDiagram
    participant U as UI
    participant API as Runs API
    participant R as Runner
    participant LLM as Claude Code
    participant DB as SQLite

    U->>API: POST /api/runs/scan {query}
    API->>DB: take the scan lock (409 if a scan is live)
    API->>LLM: nl-filter (parse the sentence)
    LLM-->>API: structured criteria
    API->>DB: write criteria (id=1), invalidate old verdicts
    API-->>U: parsed criteria ("understood as")
    API->>R: runFull()

    R->>DB: boards fetched within the TTL re-run L1 on their stored jobs
    R->>R: fetch the other adapters (streamed, pooled, per-source deadline)
    loop each job
        R->>R: validate against JobShape (skip + count malformed)
        R->>R: L1 rules (title/location/salary/seniority/freshness)
        R->>R: enrich L1 survivors lacking a JD (budgeted, sequential)
        R->>DB: upsert (fold duplicates, refresh edited postings) + stamp last_run_id
    end
    R-->>U: SSE scan_done (non-terminal)

    R->>DB: legitimacy pass (ghost signal)
    R->>DB: semantic dedup (fold reposts)
    R->>R: L1.5 pre-rank survivors best-first
    loop batches of 20
        R->>LLM: verdict (grade vs criteria)
        LLM-->>R: scores + fit
        R->>DB: write l2_verdict / l2_score / l2_fit
        R-->>U: SSE l2_progress
    end
    R->>DB: set runs.finished_at
    R-->>U: SSE l2_done (terminal)
```

### Two-phase progress

A scan reports progress in two phases, and the distinction matters:

- `scan_done` fires when L1 finishes. It is **non-terminal**, and the SSE stream
  stays open because L2 events are still coming.
- `l2_done` is terminal, and `runs.finished_at` is set only after L2 completes.
  `runL2Pass` writes `finished_at` *before* emitting `l2_done` on every exit path
  (normal, nothing pending, aborted).
- `error` is the other terminal event: if `runFull` throws after the run row
  exists, it records the error in `errors_json`, sets `finished_at`, emits
  `error`, and releases the scan lock.

Marking a run finished at the end of L1 would make the UI look done while the
model is still scoring. The Search page treats a run with `finished_at === null`
as in progress and reconnects to its stream.

### One scan at a time

`POST /api/runs/scan` takes the scan lock *before* the multi-second `nl-filter`
call, so two overlapping searches can't both start a run or rewrite the criteria
under each other; every early exit (bad body, nl-filter failure) releases it, and
`runFull` releases it when the run ends. `createRun` then snapshots the criteria
(YAML, parsed form, and the original search sentence) once, so a later search
can't change the rubric partway through a run. A lock is stale when its recorded
pid is dead (or, with no pid, after an hour). At startup, `recoverInterruptedScans`
clears a dead process's lock and marks its unfinished runs finished with an
"interrupted" error, so a crash never leaves the UI stuck on "Scanning".

### Per-source isolation

Each source runs in its own slot of a 10-wide pool with its own `AbortController`
and an 8-minute deadline covering fetch and enrichment. A board that hangs is
aborted and recorded with `last_status = 'timeout'` and a `source_error` event;
the rest of the scan carries on. Jobs that fail the `JobShape` contract are
skipped and counted in that source's `source_done` message rather than stored.

### Board cache

A per-company board returns its whole listing whatever you search, so fetching
15,000 of them per query is wasted work. `sources.last_ok_fetch_at` records the
start of each board's last complete successful fetch. A scan serves a board whose
fetch is within the TTL (Settings, default 6h, 0 = off) from its stored jobs: it
re-runs L1 under the current criteria over the jobs that fetch listed
(`board_sightings.seen_at >= last_ok_fetch_at` for that board, so jobs that dropped
off stay closed even if another source still lists them) and stamps `last_run_id` + the verdict on each, as a fetched job would be.
Stale boards, boards never fetched, every keyword aggregator, and any fetch that
depended on the search keywords (Workable's `?query=` fallback, flagged through
`ctx.markQueryDependent`) are fetched live.
Failed, partial or timed-out fetches never advance the timestamp. The cache phase
runs before the live pool, commits in short slices and yields to the event loop
(the scan-lock heartbeat keeps running). L1 survivors still missing a JD on an
`enrich()` adapter go through the normal enrich pipeline from the stored row.
Progress reports "N boards from cache, M fetched live".

### Background board refresher

Boards only become fresh when something fetches them, so with thousands enabled the
first search would fetch them all and they would go stale between searches.
`src/runner/board-refresher.ts` is one in-process loop (started from `server.ts`
after a short delay, not under `bun test`) that keeps enabled per-company boards
warm. Each pass picks up to 100 enabled, non-aggregator boards whose
`last_ok_fetch_at` is NULL or older than the TTL minus a margin (the smaller of 1h
and 20% of the TTL), never-fetched first then oldest, and fetches them 3 at a time
through the same adapters and `upsertJob` a scan uses. Content-change semantics are
identical (an edit wipes the L2 verdict and embedding, a dropped job closes), and
`last_ok_fetch_at` advances only when the stream ran to the end.

A refresh takes no part in any search: it passes no run to `upsertJob`, so it never
stamps `last_run_id`, emits no progress, and leaves `l1_pass`/`l1_reasons`/`l1_rescued`
untouched (a new job starts unevaluated). L1 depends on the criteria, which change with
every search, and the scan's cache phase re-grades every open stored job under the
current criteria anyway, so computing it here would be wasted writes. No L2,
legitimacy, rescue, embeddings or `enrich()` either: enrich is per-survivor and
criteria-dependent, so a scan does it.

A search always wins. The refresher never holds the scan lock. It pauses while one is
held, aborts in-flight fetches within about a second of one appearing, and writes each
board in whole-transaction chunks of 200 jobs that re-check the lock first, so no
refresher write can land after a scan has taken the lock. An aborted board keeps the
chunks already committed but never advances `last_ok_fetch_at` and is not counted as a
failure. `clear-jobs` also cancels in-flight refreshes.

Politeness: shared API hosts (Greenhouse, Ashby, Lever, SmartRecruiters, Rippling,
Workable) get a minimum gap between board starts of 0.4s (0.3-0.5s with jitter), Rippling
0.6s, Workable 1.5s. Adapters pass the scan's abort signal into `fetchJson`/`fetchText`
(`FetchOpts.signal`), which cancels the request and its retry sleeps, so an abort is real. A 429
that survives `fetchJson`'s `Retry-After`-aware retries rests that whole host for 30s,
doubling per consecutive 429 up to 10 minutes, and the host's boards are left out of
selection meanwhile. A failing board records `last_status`/`last_error` like a scan and
backs off `refresh_retry_at` exponentially (15 min doubling to 24h, reset by any
successful fetch). A board that only answers keyword searches (Workable's oversized
accounts) is skipped quietly for a day. The tick logs one summary line plus one line per
failure class. Settings: "Keep boards fresh in background" (settings KV `board_refresh`,
default on) with live status from `GET /api/settings/board-refresh`. Because it re-fetches
every enabled board once per cache window, turning on all ~15.5k discovered boards means
re-downloading them every TTL (6h by default): raise the TTL to cut the traffic.

A refresh that detects a real edit to a posting clears its L2 verdict and embedding, the
same as a live fetch, but between searches. The job then counts toward `l2_pending` until
the next search re-grades it. The final stamp of `last_ok_fetch_at` is guarded on the
board's config and name as selected, so editing a board mid-refresh aborts that refresh
instead of marking the old config's jobs fresh.

## Design choices worth knowing

- **Deterministic rules run inline; the model runs in a separate pass.** L1 filters
  while jobs stream in, so most of the corpus never costs a token. Only survivors
  reach L2.
- **Results are scoped to the current search.** Every job a run surfaces is
  stamped with `last_run_id`, and the Jobs API filters and ranks by it. Each
  search shows its own result set, ordered by L2 score.
- **Grading is batched.** Each Claude Code invocation carries a fixed, uncacheable
  cost, so L2 grades 20 jobs per call rather than one. See
  [filtering-and-ranking.md](filtering-and-ranking.md).
- **Deduplication stays linear.** Fuzzy dedup prefilters on an indexed normalized
  company column instead of scanning the whole table, which matters at hundreds of
  boards. Two postings fold only when they are the same role at the same level in
  a compatible location. See [data-model.md](data-model.md).
- **Matching is whole-word.** Criteria terms match as whole words or phrases,
  with a place gazetteer and a remote-eligibility rule for locations. See
  [filtering-and-ranking.md](filtering-and-ranking.md).

## Stack

- **[Bun](https://bun.sh)** provides the runtime, `bun:sqlite`, built-in fetch, and the test runner.
- **[Hono](https://hono.dev)** is the HTTP server, with SSE for progress.
- **[cheerio](https://cheerio.js.org)** handles HTML/XML parsing.
- **[zod](https://zod.dev)** validates every LLM output and adapter contract.
- **Vite + React 19 + Tailwind CSS 4** for the single-page UI.
- **[@huggingface/transformers](https://github.com/huggingface/transformers.js)**
  on the CPU backend, running the local embedding model.
