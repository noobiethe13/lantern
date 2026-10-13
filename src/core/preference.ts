import { centroidOf } from './semantic-rescue';
import { cosineSim } from './embed';

// Learned taste: how the user triages (shortlist/apply vs dismiss) nudges the ORDER
// of results, never which jobs pass L1/L2. Pure math lives here, the DB reads in
// runner/preference.ts. Everything is derived from vectors the pre-ranker already
// cached, so it costs no LLM tokens and no extra embedding work.

export type TriageSignal = 'liked' | 'disliked';

/** A model needs at least this many jobs on the liked side (after the per-company
 *  cap) to activate. Three shortlisted jobs is a taste, one is an accident. */
export const PREF_MIN_LIKED = 3;

/** The dismissed side is optional: below this it is ignored rather than blocking
 *  the model, since a user who only ever shortlists has still said something. */
export const PREF_MIN_DISLIKED = 3;

/** At most this many jobs per company per side. The embedded text is title + company
 *  + JD truncated by the model, so one employer's shared boilerplate can dominate its
 *  vectors and drag a centroid toward itself (same hazard as semantic rescue). At 2,
 *  PREF_MIN_LIKED = 3 also implies at least two distinct companies. */
export const PREF_MAX_PER_COMPANY = 2;

/** Most recently discovered triaged jobs win when a side has more than this, so
 *  taste leans toward the current search rather than old history. */
export const PREF_MAX_PER_SIDE = 200;

/** Weight of the dismissed centroid. Below 1 so "looks like what I dismissed" is a
 *  weaker statement than "looks like what I wanted". Untuned: no real triage data
 *  exists yet, see docs/intelligence.md. */
export const PREF_LAMBDA = 0.5;

/** Maps the (centered) raw preference to a score delta. A 0.2 cosine gap between two
 *  jobs reaches the cap. Untuned, like PREF_LAMBDA. */
export const PREF_GAIN = 0.5;

/** The largest score delta personalization can apply either way. Small on purpose:
 *  it reorders near-ties on the 0..1 L2 scale but cannot bury a strong match. */
export const PREF_MAX_ADJUST = 0.1;

export interface PreferenceModel {
  liked: Float32Array;
  /** Null when fewer than PREF_MIN_DISLIKED dismissed jobs carry a vector. */
  disliked: Float32Array | null;
  likedCount: number;
  dislikedCount: number;
}

export interface PreferenceSample {
  vec: Float32Array;
  signal: TriageSignal;
  /** company_norm, or '' when unknown. */
  company: string;
}

/**
 * Build the liked/disliked centroids from triaged jobs, most recently discovered first (jobs carry no triage timestamp, so id order is the closest proxy). Applies the
 * per-company and per-side caps. Returns null (feature off) unless the liked side
 * reaches PREF_MIN_LIKED.
 */
export function buildPreferenceModel(samples: PreferenceSample[]): PreferenceModel | null {
  const pick = (signal: TriageSignal): Float32Array[] => {
    const perCompany = new Map<string, number>();
    const vecs: Float32Array[] = [];
    for (const s of samples) {
      if (s.signal !== signal || vecs.length >= PREF_MAX_PER_SIDE) continue;
      const seen = perCompany.get(s.company) ?? 0;
      if (seen >= PREF_MAX_PER_COMPANY) continue;
      perCompany.set(s.company, seen + 1);
      vecs.push(s.vec);
    }
    return vecs;
  };

  const liked = pick('liked');
  if (liked.length < PREF_MIN_LIKED) return null;
  const disliked = pick('disliked');
  return {
    liked: centroidOf(liked),
    disliked: disliked.length >= PREF_MIN_DISLIKED ? centroidOf(disliked) : null,
    likedCount: liked.length,
    dislikedCount: disliked.length,
  };
}

/** sim(liked) - lambda * sim(disliked). Uncentered: only differences between jobs mean anything. */
export function rawPreference(model: PreferenceModel, vec: Float32Array): number {
  const dislike = model.disliked ? cosineSim(model.disliked, vec) : 0;
  return cosineSim(model.liked, vec) - PREF_LAMBDA * dislike;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Per-job score delta in [-PREF_MAX_ADJUST, +PREF_MAX_ADJUST]. Centered on the median
 * of the jobs being compared: MiniLM cosines between any two job postings sit well
 * above zero, so an absolute value would lift everything. Centering makes "better
 * than a typical job in this view" positive. Jobs without a vector get no entry (a
 * delta of 0).
 */
export function preferenceAdjustments(
  model: PreferenceModel,
  items: { id: number; vec: Float32Array | null | undefined }[],
): Map<number, number> {
  const raws: { id: number; raw: number }[] = [];
  for (const it of items) if (it.vec) raws.push({ id: it.id, raw: rawPreference(model, it.vec) });
  const out = new Map<number, number>();
  if (raws.length === 0) return out;
  const center = median(raws.map((r) => r.raw));
  for (const r of raws) {
    const delta = PREF_GAIN * (r.raw - center);
    out.set(r.id, Math.max(-PREF_MAX_ADJUST, Math.min(PREF_MAX_ADJUST, delta)));
  }
  return out;
}

export interface RankableJob {
  id: number;
  l2_score: number | null;
  l2_fit: number | null;
  l1_pass: number;
  first_seen: number;
}

/**
 * The Jobs list order: L2-scored first, fits before non-fits, then by score with the
 * preference delta added, then L1 survivors, then recency. Tiering on l2_fit is what
 * lets the delta stay a tie-breaker: it can swap two fits that are within PREF_MAX_ADJUST
 * x 2 of each other but never lift a non-fit over a fit. Mirrors the SQL ORDER BY used
 * when no model is active (see routes/jobs.ts).
 */
export function compareRank(adjust: Map<number, number>): (a: RankableJob, b: RankableJob) => number {
  const key = (j: RankableJob) => (j.l2_score ?? 0) + (adjust.get(j.id) ?? 0);
  return (a, b) => {
    const aScored = a.l2_score != null;
    const bScored = b.l2_score != null;
    if (aScored !== bScored) return aScored ? -1 : 1;
    if (aScored && (a.l2_fit ?? 0) !== (b.l2_fit ?? 0)) return (b.l2_fit ?? 0) - (a.l2_fit ?? 0);
    if (aScored && key(a) !== key(b)) return key(b) - key(a);
    if (a.l1_pass !== b.l1_pass) return b.l1_pass - a.l1_pass;
    if (a.first_seen !== b.first_seen) return b.first_seen - a.first_seen;
    return b.id - a.id;
  };
}
