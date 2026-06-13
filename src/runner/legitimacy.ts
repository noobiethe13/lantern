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
  db.run('UPDATE jobs SET legitimacy = ?, legitimacy_reasons = ? WHERE id = ?', [
    legitimacy,
    reasons.length > 0 ? JSON.stringify(reasons) : null,
    row.id,
  ]);
}

/**
 * Score every job the run surfaced. Deterministic and LLM-free, so it runs
 * between scan and L2 — badges are ready while L2 is still scoring.
 */
export function applyLegitimacyPass(runId: number): number {
  const rows = db
    .query<LegitimacyRow, [number]>(
      `SELECT ${ROW_COLUMNS} FROM jobs WHERE last_run_id = ?`
    )
    .all(runId);

  const now = Date.now();
  for (const row of rows) scoreAndPersist(row, now);
  return rows.length;
}

/** Recompute one job after its inputs changed (e.g. a liveness check wrote). */
export function recomputeLegitimacy(jobId: number): void {
  const row = db
    .query<LegitimacyRow, [number]>(`SELECT ${ROW_COLUMNS} FROM jobs WHERE id = ?`)
    .get(jobId);
  if (row) scoreAndPersist(row, Date.now());
}
