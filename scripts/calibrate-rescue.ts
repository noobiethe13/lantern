// Calibrates the semantic-rescue operating point against the labelled set in
// scripts/fixtures/rescue-calibration.ts. Run:
//
//   bun run scripts/calibrate-rescue.ts [--verbose]
//
// Also sweeps the query floor (a candidate must be at least this close to the query
// to be promoted by the centroid, a guard against a drifted centroid).
//
// Scores every title-miss posting by similarity to the query anchor
// (criteriaToQueryText, what the pre-ranker uses), to the centroid of the search's
// L1 survivors, and by their mean and max. The best-recall threshold with
// precision >= TARGET_PRECISION is picked on the 'fit' queries and then reported on
// the held-out queries, so the quoted numbers are not the ones it was tuned on.
//
// It never opens the DB: embed-fill.ts imports db/client (which would migrate
// data/), so the job text shape is mirrored here instead of imported. Keep it in
// sync with jobEmbeddingText.

import { cosineSim, criteriaToQueryText, embedTexts } from '../src/core/embed';
import {
  RESCUE_MIN_SIMILARITY_CENTROID,
  RESCUE_MIN_QUERY_FLOOR,
  RESCUE_MIN_SIMILARITY_QUERY,
  centroidOf,
} from '../src/core/semantic-rescue';
import { RESCUE_FIXTURES } from './fixtures/rescue-calibration';

const TARGET_PRECISION = 0.6;

interface Scored {
  query: number;
  centroid: number;
  mean: number;
  max: number;
  /** Centroid similarity, but -1 when the query similarity is under the floor. */
  floored: number;
  split: 'fit' | 'holdout';
  match: boolean;
  label: string;
}
type ScoreKey = 'query' | 'centroid' | 'floored' | 'mean' | 'max';

const jobText = (i: { title: string; company: string; jd: string }) => [i.title, i.company, i.jd].join('\n');

/** Probability a random match outranks a random non-match (1 = perfectly separable). */
function auc(scored: Scored[], key: ScoreKey): number {
  const pos = scored.filter((s) => s.match);
  const neg = scored.filter((s) => !s.match);
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p[key] > n[key] ? 1 : p[key] === n[key] ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

function at(scored: Scored[], key: ScoreKey, t: number) {
  const promoted = scored.filter((s) => s[key] >= t);
  const tp = promoted.filter((s) => s.match).length;
  const positives = scored.filter((s) => s.match).length;
  return { n: promoted.length, precision: promoted.length ? tp / promoted.length : NaN, recall: tp / positives };
}

/** Lowest-recall-loss threshold: the highest-recall cut whose precision >= target. */
function pickThreshold(fit: Scored[], key: ScoreKey): number {
  let best = { t: Infinity, recall: -1 };
  for (let t = 0.2; t <= 0.8001; t += 0.005) {
    const r = at(fit, key, t);
    if (r.n > 0 && r.precision >= TARGET_PRECISION && r.recall > best.recall) best = { t, recall: r.recall };
  }
  return best.t;
}

const f = (x: number) => (Number.isNaN(x) ? '  -  ' : x.toFixed(3));

async function main() {
  const scored: Scored[] = [];
  for (const q of RESCUE_FIXTURES) {
    const [anchor] = await embedTexts([criteriaToQueryText(q.criteria)]);
    const survivorVecs = await embedTexts(q.survivors.map(jobText));
    const centroid = centroidOf(survivorVecs);
    const vecs = await embedTexts(q.items.map(jobText));
    q.items.forEach((item, i) => {
      const sq = cosineSim(anchor, vecs[i]);
      const sc = cosineSim(centroid, vecs[i]);
      scored.push({
        query: sq,
        centroid: sc,
        mean: (sq + sc) / 2,
        max: Math.max(sq, sc),
        floored: sq >= RESCUE_MIN_QUERY_FLOOR ? sc : -1,
        split: q.split,
        match: item.match,
        label: `${q.query.slice(0, 22)} | ${item.title}`,
      });
    });
  }

  const fit = scored.filter((s) => s.split === 'fit');
  const holdout = scored.filter((s) => s.split === 'holdout');
  const count = (xs: Scored[]) => `${xs.length} (${xs.filter((s) => s.match).length} match)`;
  console.log(`fit: ${count(fit)}   holdout: ${count(holdout)}   target precision >= ${TARGET_PRECISION}\n`);

  console.log('score     AUC fit  AUC holdout  threshold(fit)  holdout: promoted  precision  recall');
  for (const key of ['query', 'centroid', 'floored', 'mean', 'max'] as ScoreKey[]) {
    const t = pickThreshold(fit, key);
    const h = at(holdout, key, t);
    console.log(
      `${key.padEnd(9)} ${f(auc(fit, key))}    ${f(auc(holdout, key))}        ${t.toFixed(3)}           ${String(h.n).padStart(3)}              ${f(h.precision)}      ${f(h.recall)}`,
    );
  }

  console.log('\nquery-floor sweep (centroid threshold re-picked on fit for each floor):');
  console.log('floor  threshold  fit recall  holdout: promoted  precision  recall');
  for (let floor = 0; floor <= 0.3001; floor += 0.03) {
    const keyed = (rows: Scored[]) => rows.map((r) => ({ ...r, floored: r.query >= floor ? r.centroid : -1 }));
    const t = pickThreshold(keyed(fit), 'floored');
    const fr = at(keyed(fit), 'floored', t);
    const h = at(keyed(holdout), 'floored', t);
    console.log(
      `${floor.toFixed(2)}   ${t.toFixed(3)}      ${f(fr.recall)}       ${String(h.n).padStart(3)}              ${f(h.precision)}      ${f(h.recall)}`,
    );
  }

  const shipped = (label: string, key: ScoreKey, t: number) => {
    const h = at(holdout, key, t);
    console.log(`  ${label} ${t}: ${h.n} promoted, precision ${f(h.precision)}, recall ${f(h.recall)}`);
  };
  console.log('\nshipped thresholds on holdout:');
  shipped(`centroid anchor, query floor ${RESCUE_MIN_QUERY_FLOOR}`, 'floored', RESCUE_MIN_SIMILARITY_CENTROID);
  shipped('query anchor (fallback)', 'query', RESCUE_MIN_SIMILARITY_QUERY);

  if (process.argv.includes('--verbose')) {
    console.log('\nholdout, ranked by mean score (match marked *):');
    for (const s of [...holdout].sort((a, b) => b.mean - a.mean)) {
      console.log(`  ${s.mean.toFixed(3)} (q ${s.query.toFixed(3)} c ${s.centroid.toFixed(3)}) ${s.match ? '*' : ' '} ${s.label}`);
    }
  }
}

main();
