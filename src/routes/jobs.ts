import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client';
import { runLivenessCheck } from '../runner/liveness';
import { deserializeVector, topKSimilar } from '../core/embed';
import { zodErrorBody } from '../server/errors';

export const jobs = new Hono();

const JOB_STATUSES = ['new', 'shortlist', 'applied', 'interview', 'offer', 'rejected', 'hidden'] as const;

// Query params are always strings (or absent) at this boundary — a negative
// LIMIT is "unlimited" in SQLite (bypassing the cap) and a non-numeric value
// throws SQLITE_MISMATCH once bound, so validate before it reaches the query.
function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

jobs.get('/', c => {
  const status = c.req.query('status');
  const l1 = c.req.query('l1');
  const l2 = c.req.query('l2');
  const fit = c.req.query('fit');
  const remote = c.req.query('remote');
  const sourceType = c.req.query('source_type');
  const run = c.req.query('run');
  const q = c.req.query('q');
  const limit = clampInt(c.req.query('limit'), 100, 1, 500);
  const offset = clampInt(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER);

  type Binding = string | number | null;
  const conditions: string[] = [];
  const params: Binding[] = [];

  if (status) {
    const statuses = status.split(',').filter(s => JOB_STATUSES.includes(s as typeof JOB_STATUSES[number]));
    if (statuses.length > 0) {
      conditions.push(`j.status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
  }
  if (l1 === '1') conditions.push('j.l1_pass = 1');
  const legitimacy = c.req.query('legitimacy');
  if (legitimacy) {
    const bands = legitimacy.split(',').filter(b => ['high', 'caution', 'suspicious'].includes(b));
    if (bands.length > 0) {
      conditions.push(`j.legitimacy IN (${bands.map(() => '?').join(',')})`);
      params.push(...bands);
    }
  }
  if (l2 === '1') conditions.push('j.l2_verdict_json IS NOT NULL');
  if (fit === '1') conditions.push('j.l2_fit = 1');
  if (remote === '1') conditions.push('j.remote = 1');
  if (sourceType) {
    // Comma-separated list → s.type IN (...). Supports multi-select source filter.
    const types = sourceType.split(',').map(s => s.trim()).filter(Boolean);
    if (types.length > 0) {
      conditions.push(`s.type IN (${types.map(() => '?').join(',')})`);
      params.push(...types);
    }
  }
  // Scope to a search: `latest` = the most recent run, or an explicit run id.
  if (run === 'latest') {
    conditions.push('j.last_run_id = (SELECT MAX(id) FROM runs)');
  } else if (run && /^\d+$/.test(run)) {
    conditions.push('j.last_run_id = ?');
    params.push(Number(run));
  }
  if (q) {
    conditions.push('(j.title LIKE ? OR j.company LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  // Semantic near-duplicates fold into a canonical posting (jobs.duplicate_of) and
  // are hidden by default so the user sees one row per real job. include_duplicates=1
  // surfaces them (each carries duplicate_of so the UI can mark it).
  if (c.req.query('include_duplicates') !== '1') {
    conditions.push('j.duplicate_of IS NULL');
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // The UI masthead promises "ranked by fit" — honor it in every view:
  // L2-scored first (best leading), then L1 survivors, then the rest by recency.
  const orderBy = 'ORDER BY (j.l2_score IS NULL), j.l2_score DESC, j.l1_pass DESC, j.first_seen DESC';

  const rows = db.query<Record<string, unknown>, Binding[]>(
    `SELECT j.*, s.display_name AS source_name, s.type AS source_type,
            (SELECT COUNT(*) FROM jobs d WHERE d.duplicate_of = j.id) AS duplicate_count
     FROM jobs j
     LEFT JOIN sources s ON s.id = j.source_id
     ${where}
     ${orderBy}
     LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  // LEFT JOIN sources so a source_type filter (which references s.type) resolves
  // here too — the WHERE clause is shared with the rows query above.
  const total = db.query<{ n: number }, Binding[]>(
    `SELECT COUNT(*) AS n FROM jobs j LEFT JOIN sources s ON s.id = j.source_id ${where}`
  ).get(...params)?.n ?? 0;

  return c.json({ jobs: rows.map(parseJobRow), total, limit, offset });
});

jobs.get('/:id', c => {
  const row = db.query<Record<string, unknown>, [number]>(
    `SELECT j.*, s.display_name AS source_name, s.type AS source_type,
            (SELECT COUNT(*) FROM jobs d WHERE d.duplicate_of = j.id) AS duplicate_count
     FROM jobs j LEFT JOIN sources s ON s.id = j.source_id
     WHERE j.id = ?`
  ).get(Number(c.req.param('id')));
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json(parseJobRow(row));
});

// Near-duplicate postings that fold into this (canonical) job — the same-employer
// reposts the semantic-dedup pass detected. These are kept but hidden from the
// default list and skipped by L2; surfacing them here lets the detail panel show
// "also posted as, not separately scored". Empty when the job has no duplicates.
jobs.get('/:id/duplicates', c => {
  const id = Number(c.req.param('id'));
  const rows = db
    .query<Record<string, unknown>, [number]>(
      `SELECT j.*, s.display_name AS source_name, s.type AS source_type
       FROM jobs j LEFT JOIN sources s ON s.id = j.source_id
       WHERE j.duplicate_of = ?
       ORDER BY j.first_seen DESC`,
    )
    .all(id);
  return c.json({ jobs: rows.map(parseJobRow) });
});

// Nearest-neighbour jobs by sentence embedding. Read-only: useful as a "more
// like this" triage action once a job catches the eye. Only spans jobs that
// already carry an embedding (i.e. have been through an L1.5 prerank pass) — an
// empty list means the target (or the store) hasn't been embedded yet.
jobs.get('/:id/similar', c => {
  const id = Number(c.req.param('id'));
  const limit = clampInt(c.req.query('limit'), 8, 1, 25);

  const target = db
    .query<{ embedding: Uint8Array | null }, [number]>('SELECT embedding FROM jobs WHERE id = ?')
    .get(id);
  const targetVec = deserializeVector(target?.embedding);
  if (!targetVec) return c.json({ jobs: [] });

  // Rank on id + embedding only — this runs on every detail-panel open (j/k
  // navigation), so pulling full rows (jd_text, embedding BLOB, ...) for every
  // embedded job in the store just to throw all but `limit` away is wasteful.
  // Full rows are fetched only for the winning top-k ids below.
  const idRows = db
    .query<{ id: number; embedding: Uint8Array | null }, [number]>(
      `SELECT id, embedding FROM jobs
       WHERE embedding IS NOT NULL AND id != ? AND status != 'hidden' AND duplicate_of IS NULL`,
    )
    .all(id);

  const candidates: { vec: Float32Array; item: number }[] = [];
  for (const row of idRows) {
    const vec = deserializeVector(row.embedding);
    if (vec) candidates.push({ vec, item: row.id });
  }

  const ranked = topKSimilar(targetVec, candidates, limit);
  if (ranked.length === 0) return c.json({ jobs: [] });

  const rows = db
    .query<Record<string, unknown>, number[]>(
      `SELECT j.*, s.display_name AS source_name, s.type AS source_type
       FROM jobs j LEFT JOIN sources s ON s.id = j.source_id
       WHERE j.id IN (${ranked.map(() => '?').join(',')})`,
    )
    .all(...ranked.map(r => r.item));

  const byId = new Map(rows.map(r => [Number(r['id']), r]));
  const result: Record<string, unknown>[] = [];
  for (const r of ranked) {
    const row = byId.get(r.item);
    if (row) result.push({ ...parseJobRow(row), similarity: r.sim });
  }
  return c.json({ jobs: result });
});

jobs.patch('/:id/status', async c => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ status: z.enum(JOB_STATUSES) }).safeParse(body);
  if (!parsed.success) return c.json(zodErrorBody(parsed.error), 400);

  const { status } = parsed.data;
  const id = Number(c.req.param('id'));
  const now = Date.now();
  db.run(
    `UPDATE jobs SET status = ?, applied_at = CASE WHEN ? = 'applied' AND applied_at IS NULL THEN ? ELSE applied_at END WHERE id = ?`,
    [status, status, now, id]
  );
  return c.json({ ok: true });
});

jobs.patch('/:id/notes', async c => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ notes: z.string().max(4000) }).safeParse(body);
  if (!parsed.success) return c.json(zodErrorBody(parsed.error), 400);

  db.run('UPDATE jobs SET notes = ? WHERE id = ?', [parsed.data.notes, Number(c.req.param('id'))]);
  return c.json({ ok: true });
});

jobs.post('/liveness', async c => {
  try {
    const summary = await runLivenessCheck();
    return c.json(summary);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

function parseJobRow(row: Record<string, unknown>): Record<string, unknown> {
  // company_norm is an internal dedup prefilter column and embedding is a raw
  // Float32 BLOB — both are internal-only, drop them from the API response.
  const { l2_verdict_json, l1_reasons, duplicate_urls, company_norm, legitimacy_reasons, embedding, ...rest } = row;
  void company_norm;
  void embedding;
  return {
    ...rest,
    l2_verdict: l2_verdict_json ? JSON.parse(l2_verdict_json as string) : null,
    l1_reasons: l1_reasons ? JSON.parse(l1_reasons as string) : null,
    duplicate_urls: duplicate_urls ? JSON.parse(duplicate_urls as string) : null,
    legitimacy_reasons: legitimacy_reasons ? JSON.parse(legitimacy_reasons as string) : null,
  };
}
