---
paths:
  - src/runner/**
  - src/db/**
  - src/routes/runs.ts
  - src/routes/jobs.ts
---

# Scan runner, progress, and DB invariants

- **Two-phase progress.** `runScan` emits `scan_done` (NON-terminal) at the L1→L2
  handoff. The SSE stream (`routes/runs.ts`) and the `useSSE` hook only close on
  `l2_done` / `done` / `error`. Do NOT emit `done` at L1-end — it cuts the stream
  before L2 events and makes the UI look stuck.
- **`finished_at` is set only after L2** (in `runFull`, after `runL2Pass`). Setting
  it at L1-end marks the run complete while L2 is still scoring. The Search page
  treats a run with `finished_at === null` as in-progress (and reconnects to it).
- **Run scoping.** `upsertJob` stamps `last_run_id` on every job a run surfaces
  (insert + seen + fuzzy-merge). L2 and the Jobs API scope by it (`?run=latest`),
  so each search shows its own result set. `l2_score`/`l2_fit` are denormalized
  for `?fit=1` + `ORDER BY l2_score DESC`.
- **Criteria is derived.** The scan endpoint runs `nl-filter` → writes the
  `criteria` id=1 row → invalidates verdicts (`l2_verdict_json`+`l2_score`+
  `l2_fit`). There is no `/api/criteria` route; the runner reads criteria from the
  DB (`loadCriteria`, fallback `src/config/search.yml`).
- **Dedup stays linear.** `findFuzzyDuplicate` prefilters on the indexed
  `company_norm` column — never reintroduce a full-table scan (O(n²) at 300+ boards).
- **Discovered boards.** `seedSources` also runs `seedDiscoveredSources`, which
  `INSERT OR IGNORE`s `src/config/discovered-sources.json` as `enabled=0`,
  `origin='discovered'` rows. No retire sync, never enables, and a seed-list entry
  with the same slug adopts the row (`origin` NULL, enabled). They stay out of
  `GET /api/sources` and are bulk-toggled via `PUT /api/sources/discovered`.
- **Schema/migrations.** `schema.sql` defines the full schema for fresh DBs;
  `migrate.ts` ALTERs pre-existing DBs (idempotent, guarded). Keep schema.sql
  comments **semicolon-free** — `migrate.ts` splits on `;` before stripping
  comments. Migrations aren't test-covered: verify changes with `runMigrations`
  on a `:memory:` DB. Indexes on migration-added columns go in `migrate.ts`.
- **JD-derived salary.** `scanOne` fills a salaryless job from `fillSalaryFromJd`
  (`runner/jd-salary.ts`) before L1 and again after `enrich()`, and passes the
  `salary_source` (`ats`/`jd`) to `upsertJob`. In `upsertJob` a `jd` salary landing
  on a row with no salary is a backfill (no verdict/embedding wipe), a re-sighting
  with no JD of its own keeps a stored `jd` salary, and any other salary movement
  is a normal edit. Don't fold the derived salary into `content_hash`.
- **Semantic rescue.** `applySemanticRescue` (`runner/semantic-rescue.ts`) runs in
  `runFull` right after `runScan`, before legitimacy/dedup/L2. It promotes this
  run's jobs whose ONLY L1 reason is `TITLE_MISSING_REASON` (`l1_pass=1`,
  `l1_rescued=1`), capped per run (anchor: centroid of the run's L1 survivors,
  query anchor if under 5), and no-ops when embeddings are off or fail.
  Every `upsertJob` UPDATE path resets `l1_rescued = 0` alongside `l1_pass`, so a
  re-scan with new criteria never inherits a stale rescue.
- **Board cache.** `runScan` partitions sources with `partitionByCache`
  (`runner/board-cache.ts`): a per-company board whose `sources.last_ok_fetch_at` is
  within the `board_cache` TTL (settings KV, default 6h, 0 = off) is NOT fetched.
  `evaluateCachedBoards` re-runs L1 over its open stored jobs (`board_sightings.seen_at >=
  last_ok_fetch_at` for THIS source, written by `upsertJob` on every sighting) and stamps `last_run_id`/`l1_pass`/`l1_reasons`/`l1_rescued=0`
  on every one (via `mergeL1`), leaving `last_seen` alone (`upsertJob(..., fetched=false)` for the enrich re-run does too).
  `POST /api/admin/clear-jobs` must null `last_ok_fetch_at` (it cascades the sightings away). `last_ok_fetch_at` is the
  fetch START, written only on the success path of a live `scanOne`: never on error,
  timeout or for `stored` (enrich-only) runs. Aggregators are never cached, nor is a fetch that called
  `ctx.markQueryDependent` (Workable's `?query=` fallback): it clears `last_ok_fetch_at`.
  Live L1 uses the EARLIER of stored/fetched `posted_at` (`earliestPosted`, owning source only) and
  `upsertJob` adopts an earlier date, so cached (stored) and live agree. `applyLegitimacyPass` is async
  and commits in 500-row keyset slices. Every
  `l1Filter` input must be a persisted jobs column. Survivors lacking a JD on an
  `enrich()` adapter are `deferred` and re-run through `scanOne(source, stored)`.
  The phase commits in ~40ms slices and yields so the lock heartbeat survives. Stamping
  is write-bound (wide rows): ~85% of the cost, so don't add per-row work to it.
- **Background refresher.** `runner/board-refresher.ts` warms stale boards via
  `upsertJob(..., runId = null)`: it must never stamp `last_run_id`, touch
  `l1_pass`/`l1_reasons`/`l1_rescued`, emit on the bus, or run enrich/L2/legitimacy/
  rescue. It never takes the scan lock: `paused()` checks `getScanningState()`, a 1s
  poll cancels in-flight fetches, and every write chunk (`WRITE_CHUNK` jobs, one
  `db.transaction`) re-checks it first, so the check and writes are one synchronous
  step. Never hold a transaction across an await. An aborted board never advances
  `last_ok_fetch_at` and is not a failure. Failures set `refresh_failures`/
  `refresh_retry_at` (exponential, 24h cap), a 429 on a shared host rests the host,
  query-dependent boards are skipped for a day. Admin `clear-jobs` calls
  `cancelInFlight()`. Tests drive `new BoardRefresher({paceMs: () => 0}).tick()`.
- **Learned taste.** `loadPreferenceModel` (`runner/preference.ts`) builds liked/
  disliked centroids from triaged jobs' cached vectors (signal = `SIGNAL_SQL`,
  shared with the calibration report). It ranks only: the Jobs list blends a
  +/-0.1 delta into `l2_score` (JS sort, `compareRank`, which must mirror the SQL
  `ORDER BY` used when no model is active) and the pre-ranker adds it to query
  similarity. Never use it in L1/L2 pass/fail, never embed from it, and don't put
  taste into the verdict prompt (it would shift scores, not just order).
- **L2 cost.** `runL2Pass` grades jobs in **batches of `L2_BATCH_SIZE` (20)** per
  `claude` call to amortize the ~15K uncacheable cold-start tokens each subprocess
  re-sends. Batches are **sequential**; each call uses `BatchVerdictShape`
  (`{verdicts:[{job_id,...}]}`) and maps results back by `job_id` (an id missing
  from a successful response is a per-job error, not an abort). Fatal-abort +
  consecutive-failure guards operate per-batch. Don't revert to per-job L2 calls.
- **Scan lock staleness.** `scan_locks` staleness is decided by pid liveness
  (`process.kill(pid, 0)`), NOT a fixed age — a live long-running scan is never
  stolen just because it's been over an hour. Two things narrow that: (1) an
  absolute 12h ceiling (`SCAN_LOCK_MAX_AGE_MS`) on time since the lock was last
  refreshed reclaims a lock regardless of pid liveness, as a backstop against a foreign OS pid the kernel reused for an
  unrelated live process; (2) `recoverInterruptedScans` (boot only) treats a lock
  whose pid equals our own freshly-started `process.pid` as stale too — no scan
  of this process can legitimately be running yet at startup, so that can only be
  pid reuse, not "our own still-running scan" (which IS how `tryAcquireScanLock`/
  `getScanningState` read a matching own-pid at runtime). Whenever a stale lock is
  cleared — at boot or by `tryAcquireScanLock` mid-run — any run left with
  `finished_at IS NULL` is immediately marked finished with an "interrupted"
  `errors_json` entry (`markOrphanRunsInterrupted`), so a crash never leaves the
  Search page stuck on "Scanning" forever. Ownership: `tryAcquireScanLock()` returns
  a per-acquisition `token` (or null); `runFull(setup, token)` refreshes
  `acquired_at` on a 60s heartbeat (`startScanLockHeartbeat`) so a long run never ages
  out, and `releaseScanLock(token)` deletes only a row it owns, so a run whose lock
  was reclaimed can never free a newer scan's lock. `started_at` (set once, never
  heartbeated) adds a 24h absolute ceiling, so a run hung inside a live server cannot
  hold the lock forever despite its heartbeat.
- **L2 cap.** `runL2Pass` grades at most `l2MaxJobs()` (settings KV `l2_cap`, default
  300) pre-ranked survivors per run (hidden jobs excluded).
  Ordering needs semantic ranking enabled, otherwise it is query order. The rest keep NULL verdicts, so an identical
  re-search continues with the next batch. `l2_done` says "N more not yet graded"
  and `GET /api/runs` exposes `l2_pending` (`countUngraded`) for the Jobs page.
