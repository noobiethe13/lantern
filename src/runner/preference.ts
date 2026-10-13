import { db } from '../db/client';
import { deserializeVector } from '../core/embed';
import { buildPreferenceModel, type PreferenceModel, type PreferenceSample, type TriageSignal } from '../core/preference';
import { embeddingEnabled } from '../routes/embeddings';

/**
 * The single definition of which triage states count as a taste signal, shared by
 * the model loader and the calibration report so the two cannot disagree.
 * Having applied (applied_at is stamped once and never cleared) outranks the status,
 * because an employer's 'rejected' after the user applied still means the user wanted
 * the job. 'rejected' or 'hidden' without ever applying is the user's own no.
 */
export const SIGNAL_SQL = `CASE
  WHEN applied_at IS NOT NULL THEN 'liked'
  WHEN status IN ('shortlist','applied','interview','offer') THEN 'liked'
  WHEN status IN ('hidden','rejected') THEN 'disliked'
END`;

const TRIAGED = `('shortlist','applied','interview','offer','hidden','rejected')`;

/**
 * Exactly the rows SIGNAL_SQL can classify, as two disjoint indexed reads (status
 * index, partial applied_at index). Filtering on SIGNAL_SQL itself scanned every
 * job on each Jobs request; an `A OR B` filter here falls back to that scan too.
 */
function triagedRows(cols: string): string {
  return `SELECT ${cols} FROM jobs WHERE status IN ${TRIAGED}
          UNION ALL
          SELECT ${cols} FROM jobs WHERE applied_at IS NOT NULL AND status NOT IN ${TRIAGED}`;
}

/**
 * Read the user's taste from their triaged jobs' cached embeddings. Computed per
 * call rather than stored: it is a few hundred 384-d vectors at most (a person has
 * only triaged so many jobs), cheaper than the invalidation a stored centroid would
 * need on every status change. Reads vectors only - never embeds - so it cannot load
 * the model. Null when embeddings are off or too few jobs are triaged.
 */
export function loadPreferenceModel(): PreferenceModel | null {
  if (!embeddingEnabled()) return null;
  const rows = db
    .query<{ embedding: Uint8Array; company: string; signal: TriageSignal }, []>(
      `SELECT embedding, COALESCE(company_norm, '') AS company, ${SIGNAL_SQL} AS signal
       FROM (${triagedRows('id, embedding, company_norm, status, applied_at')})
       WHERE embedding IS NOT NULL ORDER BY id DESC`,
    )
    .all();
  const samples: PreferenceSample[] = [];
  for (const r of rows) {
    const vec = deserializeVector(r.embedding);
    if (vec) samples.push({ vec, signal: r.signal, company: r.company });
  }
  return buildPreferenceModel(samples);
}

export interface SignalStats {
  triaged: number;
  scored: number;
  mean_score: number | null;
  fit: number;
  not_fit: number;
}

export interface Calibration {
  preference: { active: boolean; liked: number; disliked: number };
  liked: SignalStats;
  disliked: SignalStats;
}

const EMPTY_STATS: SignalStats = { triaged: 0, scored: 0, mean_score: null, fit: 0, not_fit: 0 };

/**
 * How L2's grades line up with what the user decided. Read-only. A dismissed job that
 * L2 called a fit (or a shortlisted one it called a non-fit) is the disagreement worth
 * looking at. Only jobs that still carry a verdict count toward the scored figures:
 * a criteria change clears verdicts, so older searches' triage shows only in `triaged`.
 */
export function calibrationReport(): Calibration {
  const rows = db
    .query<SignalStats & { signal: TriageSignal }, []>(
      `SELECT signal,
              COUNT(*) AS triaged,
              COUNT(l2_score) AS scored,
              AVG(l2_score) AS mean_score,
              COALESCE(SUM(l2_fit = 1), 0) AS fit,
              COALESCE(SUM(l2_fit = 0), 0) AS not_fit
       FROM (SELECT ${SIGNAL_SQL} AS signal, l2_score, l2_fit
             FROM (${triagedRows('status, applied_at, l2_score, l2_fit')}))
       WHERE signal IS NOT NULL GROUP BY signal`,
    )
    .all();
  const pick = (signal: TriageSignal): SignalStats => {
    const r = rows.find((x) => x.signal === signal);
    return r ? { triaged: r.triaged, scored: r.scored, mean_score: r.mean_score, fit: r.fit, not_fit: r.not_fit } : EMPTY_STATS;
  };
  const model = loadPreferenceModel();
  return {
    // disliked counts only when the dismissed centroid is actually in use.
    preference: { active: model !== null, liked: model?.likedCount ?? 0, disliked: model?.disliked ? model.dislikedCount : 0 },
    liked: pick('liked'),
    disliked: pick('disliked'),
  };
}
