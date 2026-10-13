import { cosineSim, topKSimilar } from './embed';

// Semantic rescue (L1.5): promotes jobs whose ONLY L1 failure was a missing title
// keyword ("Software Engineer II" on a backend search) when their text embeds close
// to what the search is about. Pure selection lives here, the DB pass in
// runner/semantic-rescue.ts.
//
// Operating point (scripts/calibrate-rescue.ts, 116 labelled title-miss postings over
// 8 searches, thresholds fit on half and reported on the held-out half): rescued jobs
// are not shown as matches, they go to L2, the real judge, and RESCUE_MAX_PROMOTIONS
// already bounds the token cost. So a false promotion costs a few tokens while a
// missed one is a lost job, which is why the cut targets precision of about 0.6, not
// the near-perfect precision (and ~20% recall) a query-only anchor needs.
//   centroid anchor (+ query floor): holdout recall 0.88 at precision 0.66
//   query anchor alone:              holdout AUC 0.78, recall 0.25 at precision 0.67
//                                    (the fallback when survivors are too few)
// The fixture's match rate (~40%) is far above a real pool's, so real precision is
// lower. The cap is what keeps that affordable.

/** Fewer L1 survivors than this and their centroid is not a stable picture of the
 *  search, so the query anchor is used instead. */
export const RESCUE_MIN_SURVIVORS = 5;

/** The centroid is built from at most this many of the run's L1 survivors, and at
 *  most RESCUE_MAX_SURVIVORS_PER_COMPANY of any one company. The embedded text is
 *  title + company + JD and the model truncates it, so a company's shared boilerplate
 *  can dominate its jobs' vectors: without the per-company cap one prolific board
 *  would drag the centroid toward itself and promote its unrelated postings. */
export const RESCUE_MAX_CENTROID_SURVIVORS = 200;
export const RESCUE_MAX_SURVIVORS_PER_COMPANY = 3;

/** Backstop for the same drift: a candidate must also be at least this close to the
 *  query anchor to be promoted by the centroid. Highest floor that keeps 90% of the
 *  fit split's recall (scripts/calibrate-rescue.ts), so holdout recall is unchanged. */
export const RESCUE_MIN_QUERY_FLOOR = 0.24;

/** Min cosine(centroid of the run's L1 survivors, job text). */
export const RESCUE_MIN_SIMILARITY_CENTROID = 0.41;

/** Min cosine(query anchor, job text), used when there are too few survivors. */
export const RESCUE_MIN_SIMILARITY_QUERY = 0.4;

/** Max promotions per run. Each one costs L2 tokens, so rescue is bounded no matter
 *  how many candidates clear the threshold (best similarity first). */
export const RESCUE_MAX_PROMOTIONS = 40;

/** A JD shorter than this is too thin to judge a title-less job on (title-only
 *  rescue is noise). */
export const RESCUE_MIN_JD_CHARS = 200;

/** Upper bound on candidates embedded per run. Embedding runs ~15-20 jobs/s on CPU
 *  and every title-miss with a JD is a candidate, so this bounds a very large first
 *  run to a couple of minutes (vectors are cached, later runs are free). */
export const RESCUE_MAX_CANDIDATES = 2000;

export interface RescueAnchor {
  vec: Float32Array;
  minSimilarity: number;
  kind: 'centroid' | 'query';
  /** Centroid anchors only: candidates must also clear this similarity to the query. */
  queryFloor?: { vec: Float32Array; minSimilarity: number };
}

/** Unit-length mean of the vectors, so cosine against it is a plain dot product. */
export function centroidOf(vecs: Float32Array[]): Float32Array {
  const c = new Float32Array(vecs[0]?.length ?? 0);
  for (const v of vecs) for (let i = 0; i < c.length; i++) c[i] += v[i];
  let norm = 0;
  for (const x of c) norm += x * x;
  norm = Math.sqrt(norm);
  return norm === 0 ? c : c.map((x) => x / norm);
}

/** The centroid of the run's L1 survivors (guarded by the query floor) when there
 *  are enough of them to be stable, else the query vector. */
export function chooseAnchor(survivorVecs: Float32Array[], query: Float32Array | undefined): RescueAnchor | null {
  if (!query) return null;
  if (survivorVecs.length >= RESCUE_MIN_SURVIVORS) {
    return {
      vec: centroidOf(survivorVecs),
      minSimilarity: RESCUE_MIN_SIMILARITY_CENTROID,
      kind: 'centroid',
      queryFloor: { vec: query, minSimilarity: RESCUE_MIN_QUERY_FLOOR },
    };
  }
  return { vec: query, minSimilarity: RESCUE_MIN_SIMILARITY_QUERY, kind: 'query' };
}

/** The candidates that clear the anchor's threshold (and query floor), best first,
 *  at most `maxPromotions`. The floor is applied before the cap so a drifted
 *  centroid cannot fill the cap with jobs unrelated to the search. */
export function selectRescues<T>(
  anchor: RescueAnchor,
  candidates: { vec: Float32Array; item: T }[],
  maxPromotions: number = RESCUE_MAX_PROMOTIONS,
): { item: T; sim: number }[] {
  const floor = anchor.queryFloor;
  const eligible = floor ? candidates.filter((c) => cosineSim(floor.vec, c.vec) >= floor.minSimilarity) : candidates;
  return topKSimilar(anchor.vec, eligible, maxPromotions).filter((r) => r.sim >= anchor.minSimilarity);
}
