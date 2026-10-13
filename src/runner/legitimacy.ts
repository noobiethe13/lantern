import { db } from '../db/client';
import { scoreLegitimacy, type LegitimacySignals } from '../core/legitimacy';

interface LegitimacyRow {
  id: number;
  url: string;
  posted_at: number | null;
  first_seen: number;
  last_seen: number;
  jd_text: string | null;
  salary_min_usd: number | null;
  salary_max_usd: number | null;
  liveness: LegitimacySignals['liveness'];
  duplicate_urls: string | null;
  // The stored result, read only by the bulk pass so an unchanged score is not rewritten.
  prev_legitimacy?: string | null;
  prev_reasons?: string | null;
}

const ROW_COLUMNS = `id, url, posted_at, first_seen, last_seen, jd_text,
       salary_min_usd, salary_max_usd, liveness, duplicate_urls`;

function scoreAndPersist(row: LegitimacyRow, now: number): void {
  const { legitimacy, reasons } = scoreLegitimacy({
    now,
    postedAt: row.posted_at,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    jdText: row.jd_text,
    salaryDisclosed: row.salary_min_usd !== null || row.salary_max_usd !== null,
    liveness: row.liveness,
    url: row.url,
    duplicateUrls: row.duplicate_urls ? JSON.parse(row.duplicate_urls) : [],
  });
  const reasonsJson = reasons.length > 0 ? JSON.stringify(reasons) : null;
  if (row.prev_legitimacy === legitimacy && row.prev_reasons === reasonsJson) return;
  db.run('UPDATE jobs SET legitimacy = ?, legitimacy_reasons = ? WHERE id = ?', [legitimacy, reasonsJson, row.id]);
}

const SLICE_ROWS = 500;

/**
 * Score every job the run surfaced. Deterministic and LLM-free, so it runs
 * between scan and L2 — badges are ready while L2 is still scoring.
 *
 * Keyset-paged and committed per slice: a run served from the board cache stamps
 * hundreds of thousands of rows, each with a JD, so loading them all or holding one
 * transaction open would freeze the API/SSE (and the scan-lock heartbeat) for the whole
 * pass. A transaction per slice keeps the bulk-write speed (an autocommitted UPDATE per
 * row measured ~2.1s per 5,000 rows on a file-backed WAL DB) and unchanged scores are
 * not rewritten.
 */
export async function applyLegitimacyPass(runId: number): Promise<number> {
  const now = Date.now();
  const page = db.query<LegitimacyRow, [number, number, number]>(
    `SELECT ${ROW_COLUMNS}, legitimacy AS prev_legitimacy, legitimacy_reasons AS prev_reasons
     FROM jobs WHERE last_run_id = ? AND id > ? ORDER BY id LIMIT ?`
  );
  let scored = 0;
  let after = 0;
  for (;;) {
    const rows = page.all(runId, after, SLICE_ROWS);
    if (rows.length === 0) return scored;
    db.transaction(() => {
      for (const row of rows) scoreAndPersist(row, now);
    })();
    scored += rows.length;
    after = rows[rows.length - 1]!.id;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

/** Recompute one job after its inputs changed (e.g. a liveness check wrote). */
export function recomputeLegitimacy(jobId: number): void {
  const row = db
    .query<LegitimacyRow, [number]>(`SELECT ${ROW_COLUMNS} FROM jobs WHERE id = ?`)
    .get(jobId);
  if (row) scoreAndPersist(row, Date.now());
}
