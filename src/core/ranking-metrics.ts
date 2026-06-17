// Pure ranking-quality metrics for judging an ordering against known relevance.
// Used by scripts/measure-preranker.ts to quantify whether the L1.5 semantic
// pre-ranker surfaces high-fit jobs earlier than the arrival (no-pre-ranker) order.
// No DB, no model — just arithmetic over arrays — so the whole module is unit
// testable without touching db/client (which would migrate data/) or the encoder.

/** Average ranks (1-indexed) of `values`, ties sharing the mean of their slots.
 * The basis for Spearman: correlating ranks instead of raw values. */
function averageRanks(values: number[]): number[] {
  const n = values.length;
  const order = [...values.keys()].sort((a, b) => values[a] - values[b]);
  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[order[j + 1]] === values[order[i]]) j++;
    const shared = (i + j) / 2 + 1; // mean of slots (i+1)..(j+1)
    for (let k = i; k <= j; k++) ranks[order[k]] = shared;
    i = j + 1;
  }
  return ranks;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const sb = b[i] - mb;
    cov += da * sb;
    va += da * da;
    vb += sb * sb;
  }
  if (va === 0 || vb === 0) return 0;
  return cov / Math.sqrt(va * vb);
}

/** Spearman rank correlation in [-1, 1]: +1 when the two series agree on order,
 * -1 when reversed. Returns 0 for degenerate input — mismatched lengths, fewer
 * than 2 points, or a constant series (no rank variance to correlate). */
export function spearmanRho(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return 0;
  return pearson(averageRanks(xs), averageRanks(ys));
}

/** Discounted cumulative gain of `gains` in the given order, to depth k.
 * Position i (0-indexed) is discounted by log2(i + 2), so slot 1 keeps full gain. */
function dcg(gains: number[], k: number): number {
  const depth = Math.min(k, gains.length);
  let sum = 0;
  for (let i = 0; i < depth; i++) sum += gains[i] / Math.log2(i + 2);
  return sum;
}

/** Normalized DCG@k in [0, 1]: the order's DCG over the ideal (gains sorted
 * desc). 1 means high-gain items are already on top; 0 when no gain exists. With
 * gain = l2_score this answers "are high-scoring jobs ranked early in this order". */
export function ndcgAtK(gainsInOrder: number[], k: number): number {
  const ideal = dcg([...gainsInOrder].sort((a, b) => b - a), k);
  return ideal > 0 ? dcg(gainsInOrder, k) / ideal : 0;
}

/** Fraction of the first k items that are positive. With label = l2_fit this is
 * "of the first k jobs L2 would score in this order, how many were a fit". 0 when
 * k <= 0 or the list is empty. */
export function precisionAtK(labelsInOrder: boolean[], k: number): number {
  const depth = Math.min(k, labelsInOrder.length);
  if (depth <= 0) return 0;
  let hits = 0;
  for (let i = 0; i < depth; i++) if (labelsInOrder[i]) hits++;
  return hits / depth;
}

/** Mean 1-indexed position of positive items (lower = surfaced earlier). NaN when
 * there are no positives — the caller decides how to render that. */
export function meanRankOfPositives(labelsInOrder: boolean[]): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < labelsInOrder.length; i++) {
    if (labelsInOrder[i]) {
      sum += i + 1;
      count++;
    }
  }
  return count === 0 ? NaN : sum / count;
}

export type OrderingLabel = 'inconclusive' | 'positive' | 'negative' | 'mixed';

export interface OrderingClassification {
  label: OrderingLabel;
  /** meanRankArrival - meanRankCosine: positive ⇒ pre-ranker surfaces fits earlier. */
  meanRankGain: number;
}

const MEAN_RANK_EPS = 0.5; // mean ranks within half a slot count as "the same"

/**
 * Honest synthesis of the cosine-order-vs-arrival comparison into one label, so
 * the report can't (as an earlier version did) claim "positive" off one metric
 * while another regressed. Each of {mean-rank, precision, Spearman ρ} votes
 * up/down/flat; only a consistent set of votes earns positive/negative, conflicts
 * are mixed. Small samples (few scored, few fits) are inconclusive regardless —
 * with a handful of fits these metrics are noise.
 */
export function classifyOrdering(input: {
  n: number;
  positives: number;
  rho: number;
  meanRankCosine: number;
  meanRankArrival: number;
  precisionCosine: number;
  precisionArrival: number;
  minN?: number;
  minPositives?: number;
}): OrderingClassification {
  const minN = input.minN ?? 20;
  const minPositives = input.minPositives ?? 10;

  // No positives ⇒ mean ranks are NaN and direction is undefined → treat as flat.
  const meanRankGain =
    Number.isNaN(input.meanRankCosine) || Number.isNaN(input.meanRankArrival)
      ? 0
      : input.meanRankArrival - input.meanRankCosine;

  if (input.n < minN || input.positives < minPositives) {
    return { label: 'inconclusive', meanRankGain };
  }

  const mrVote = meanRankGain > MEAN_RANK_EPS ? 1 : meanRankGain < -MEAN_RANK_EPS ? -1 : 0;
  const pkGain = input.precisionCosine - input.precisionArrival;
  const pkVote = pkGain > 1e-9 ? 1 : pkGain < -1e-9 ? -1 : 0;
  const rhoVote = input.rho > 0.1 ? 1 : input.rho < -0.1 ? -1 : 0;

  const votes = [mrVote, pkVote, rhoVote];
  const anyUp = votes.some((v) => v > 0);
  const anyDown = votes.some((v) => v < 0);

  let label: OrderingLabel;
  if (anyUp && !anyDown) label = 'positive';
  else if (anyDown && !anyUp) label = 'negative';
  else label = 'mixed'; // signals conflict, or all flat

  return { label, meanRankGain };
}
