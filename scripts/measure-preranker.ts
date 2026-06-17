// Measures whether the L1.5 semantic pre-ranker actually surfaces high-fit jobs
// earlier than the arrival (no-pre-ranker) order. Run it after a real scan:
//
//   bun run scripts/measure-preranker.ts [--db data/data.db] [--run <id>]
//                                        [--query "..."] [--k 10]
//
// It is READ-ONLY by construction: it opens its own bun:sqlite connection with
// { readonly: true } and never imports the db/client singleton (which would run
// migrations against data/ — a forbidden write). The only model call is embedding
// the one query string; job vectors are read from the cached `embedding` column.
//
// Why a script and not a route/UI: this is a one-off analytical tool, not a user
// feature — keeping it out of the server preserves lantern's UI-only surface.

import { Database } from 'bun:sqlite';
import yaml from 'js-yaml';
import {
  cosineSim,
  criteriaToQueryText,
  deserializeVector,
  embedTexts,
} from '../src/core/embed';
import {
  classifyOrdering,
  meanRankOfPositives,
  ndcgAtK,
  precisionAtK,
  spearmanRho,
} from '../src/core/ranking-metrics';
import type { Criteria } from '../src/core/filter';

const MIN_MEANINGFUL = 20; // below this, correlations are too noisy to trust

interface Args {
  db: string;
  run?: number;
  query?: string;
  k: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { db: 'data/data.db', k: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      console.log(
        'Usage: bun run scripts/measure-preranker.ts [--db <path>] [--run <id>] [--query "<text>"] [--k <n>]',
      );
      process.exit(0);
    } else if (a === '--db') args.db = argv[++i];
    else if (a === '--run') args.run = Number(argv[++i]);
    else if (a === '--query') args.query = argv[++i];
    else if (a === '--k') args.k = Number(argv[++i]);
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

interface CorpusRow {
  id: number;
  title: string;
  company: string;
  l2_score: number;
  l2_fit: number;
  embedding: Uint8Array;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const f2 = (x: number) => (Number.isNaN(x) ? '—' : x.toFixed(2));
const f3 = (x: number) => (Number.isNaN(x) ? '—' : x.toFixed(3));
const row = (label: string, ...cols: string[]) =>
  console.log('  ' + label.padEnd(28) + cols.map((c) => c.padStart(14)).join(''));

/** Pick the run to measure: the explicit --run, else the highest run id that has
 * any embedded+scored survivors, else the latest run overall (so the empty-corpus
 * message names the right run). */
function pickRun(db: Database, explicit?: number): number | null {
  if (explicit != null && !Number.isNaN(explicit)) return explicit;
  const withCorpus = db
    .query<{ run: number }, []>(
      `SELECT last_run_id AS run FROM jobs
       WHERE l1_pass = 1 AND embedding IS NOT NULL AND l2_score IS NOT NULL
       GROUP BY last_run_id ORDER BY run DESC LIMIT 1`,
    )
    .get();
  if (withCorpus) return withCorpus.run;
  const latest = db.query<{ id: number }, []>('SELECT MAX(id) AS id FROM runs').get();
  return latest?.id ?? null;
}

/** Resolve the query text the pre-ranker would have embedded for this run, and
 * note how faithful it is. criteria id=1 only matches the LATEST run (it is
 * overwritten each search), so older runs fall back to the raw NL query. */
function resolveQuery(
  db: Database,
  runId: number,
  override?: string,
): { text: string; source: string; faithful: boolean } | null {
  if (override) return { text: override, source: '--query override', faithful: true };

  const latest = db.query<{ id: number }, []>('SELECT MAX(id) AS id FROM runs').get();
  const isLatest = latest?.id === runId;

  if (isLatest) {
    try {
      const crit = db
        .query<{ yaml: string }, []>('SELECT yaml FROM criteria WHERE id = 1')
        .get();
      if (crit) {
        const text = criteriaToQueryText(yaml.load(crit.yaml) as Criteria);
        if (text.trim()) return { text, source: 'criteria id=1', faithful: true };
      }
    } catch {
      // criteria table absent or malformed — fall through to runs.query
    }
  }

  const r = db.query<{ query: string | null }, [number]>('SELECT query FROM runs WHERE id = ?').get(runId);
  if (r?.query?.trim()) {
    return {
      text: r.query,
      source: 'runs.query (raw NL)',
      // The pre-ranker embeds the derived criteria anchor, not the raw NL; for a
      // non-latest run that anchor is gone, so this is an approximation.
      faithful: isLatest,
    };
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = new Database(args.db, { readonly: true });

  console.log('\nlantern · pre-ranker measurement');
  console.log(`DB:   ${args.db} (read-only)`);

  const runId = pickRun(db, args.run);
  if (runId == null) {
    console.log('\nNo runs found in this DB. Run a search first.');
    db.close();
    return;
  }

  const runMeta = db.query<{ query: string | null }, [number]>('SELECT query FROM runs WHERE id = ?').get(runId);
  console.log(`Run:  #${runId}  ${JSON.stringify((runMeta?.query ?? '').slice(0, 70))}`);

  const corpus = db
    .query<CorpusRow, [number]>(
      `SELECT id, title, company, l2_score, l2_fit, embedding FROM jobs
       WHERE last_run_id = ? AND l1_pass = 1 AND embedding IS NOT NULL AND l2_score IS NOT NULL`,
    )
    .all(runId);

  if (corpus.length === 0) {
    console.log('\nCorpus: 0 jobs with BOTH an embedding and an l2_score in this run.');
    console.log('  Nothing to measure yet. To get a real verdict:');
    console.log('    1. Settings → Semantic ranking = ON  (so survivors get embedded)');
    console.log('    2. Put the `claude` CLI on PATH       (so L2 produces scores)');
    console.log('    3. Run a search, let it finish, then re-run this script.');
    db.close();
    return;
  }

  const q = resolveQuery(db, runId, args.query);
  if (!q) {
    console.log('\nNo query text available for this run. Pass one with --query "...".');
    db.close();
    return;
  }
  console.log(`Query: ${JSON.stringify(q.text)}  (source: ${q.source})`);
  if (!q.faithful) {
    console.log('  ⚠ not the latest run — using the raw NL query, not the derived');
    console.log('    criteria anchor the pre-ranker actually embedded. Approximate.');
  }

  // The single model call: embed the query. Job vectors come from the column.
  let queryVec: Float32Array;
  try {
    [queryVec] = await embedTexts([q.text]);
  } catch (err) {
    console.error(`\nCould not load the embedding model: ${err instanceof Error ? err.message : err}`);
    db.close();
    process.exit(1);
  }

  // Pair each job with its cosine to the query. Drop any row whose stored vector
  // can't be read (different model width, corruption) — cosineSim would return 0
  // and silently distort the ranking.
  const scored = corpus
    .map((j) => {
      const vec = deserializeVector(j.embedding);
      return vec ? { job: j, cos: cosineSim(queryVec, vec) } : null;
    })
    .filter((x): x is { job: CorpusRow; cos: number } => x !== null);

  const dropped = corpus.length - scored.length;
  const n = scored.length;

  // Two orderings over the SAME set: the pre-ranker order (cosine desc) and the
  // arrival order L2 would see with the feature OFF (insertion order ≈ id asc).
  const cosineOrder = [...scored].sort((a, b) => b.cos - a.cos || a.job.id - b.job.id);
  const arrivalOrder = [...scored].sort((a, b) => a.job.id - b.job.id);

  const fitOf = (x: { job: CorpusRow }) => x.job.l2_fit === 1;
  const scoreOf = (x: { job: CorpusRow }) => x.job.l2_score;

  const positives = scored.filter(fitOf).length;
  const baseRate = positives / n;

  const rho = spearmanRho(scored.map((s) => s.cos), scored.map(scoreOf));

  const k5 = Math.min(5, n);
  const kK = Math.min(args.k, n);

  const ndcgCos = ndcgAtK(cosineOrder.map(scoreOf), args.k);
  const ndcgArr = ndcgAtK(arrivalOrder.map(scoreOf), args.k);

  const p5Cos = precisionAtK(cosineOrder.map(fitOf), k5);
  const p5Arr = precisionAtK(arrivalOrder.map(fitOf), k5);
  const pkCos = precisionAtK(cosineOrder.map(fitOf), kK);
  const pkArr = precisionAtK(arrivalOrder.map(fitOf), kK);

  const mrCos = meanRankOfPositives(cosineOrder.map(fitOf));
  const mrArr = meanRankOfPositives(arrivalOrder.map(fitOf));
  const mrIdeal = positives > 0 ? (positives + 1) / 2 : NaN; // positives packed at the top
  const mrRandom = (n + 1) / 2;

  console.log(`\nCorpus: ${n} jobs · fit: ${positives} (${pct(baseRate)} base rate)` + (dropped ? ` · ${dropped} unreadable vec(s) dropped` : ''));
  if (n < MIN_MEANINGFUL) {
    console.log(`  ⚠ n=${n} < ${MIN_MEANINGFUL}: too small to be statistically meaningful — treat as a smoke, not a verdict.`);
  }

  console.log('\nDoes cosine predict L2 score?');
  console.log(`  Spearman ρ (cosine vs l2_score): ${f2(rho)}   (−1…1; >0 means the pre-ranker orders toward higher scores)`);

  console.log('\nRanking quality — higher NDCG/precision and LOWER mean-rank = fit jobs surface earlier');
  row('', 'pre-ranker', 'arrival(off)', 'ideal');
  row(`NDCG@${args.k} (gain=l2_score)`, f3(ndcgCos), f3(ndcgArr), '1.000');
  row(`Precision@${k5} (fit share)`, f3(p5Cos), f3(p5Arr), `base ${f3(baseRate)}`);
  row(`Precision@${kK} (fit share)`, f3(pkCos), f3(pkArr), `base ${f3(baseRate)}`);
  row('Mean rank of fit jobs', f2(mrCos), f2(mrArr), f2(mrIdeal));
  console.log(`  (random baseline mean rank ≈ ${f2(mrRandom)})`);

  // Honest verdict: compare the pre-ranker against the off-path on the two most
  // intuitive measures. "Arrival" IS the off-path, so this also confirms what the
  // user gets with Semantic ranking disabled.
  // Was L2 cut short? It scores in the pre-ranker's order, so an incomplete pass
  // (e.g. a session/rate limit) leaves the SCORED set = the pre-ranker's top-k by
  // cosine. Comparing cosine vs arrival within that band is range-restricted, not a
  // fair test — flag it loudly so a low ρ isn't misread as "the pre-ranker is useless".
  const embeddedSurvivors =
    db.query<{ n: number }, [number]>(
      'SELECT COUNT(*) n FROM jobs WHERE last_run_id = ? AND l1_pass = 1 AND embedding IS NOT NULL',
    ).get(runId)?.n ?? n;
  const truncated = embeddedSurvivors > n;

  const verdict = classifyOrdering({
    n,
    positives,
    rho,
    meanRankCosine: mrCos,
    meanRankArrival: mrArr,
    precisionCosine: pkCos,
    precisionArrival: pkArr,
  });
  const dir =
    verdict.meanRankGain > 0.5 ? 'earlier' : verdict.meanRankGain < -0.5 ? 'LATER' : 'about the same';
  const detail = `mean fit-rank ${f2(mrCos)} vs ${f2(mrArr)} arrival (${dir}), precision@${kK} ${f3(pkCos)} vs ${f3(pkArr)}, ρ=${f2(rho)}`;

  console.log('\nVerdict:');
  if (truncated) {
    console.log(`  ⚠ CONFOUNDED — L2 scored only ${n} of ${embeddedSurvivors} embedded survivors (cut`);
    console.log("    short, e.g. a session/rate limit). L2 scores in the pre-ranker's order, so the");
    console.log(`    scored set IS the top-${n} by cosine; "cosine vs arrival" above is range-restricted,`);
    console.log('    not a fair test. Re-run after a COMPLETE L2 pass for a clean read.');
  }
  switch (verdict.label) {
    case 'inconclusive':
      console.log(`  INCONCLUSIVE — ${positives} fit job(s) across ${n} scored is too few to separate`);
      console.log(`    signal from noise (want n ≥ 20 and ≥ 10 fits). ${detail}.`);
      break;
    case 'positive':
      console.log(`  Positive — fit jobs surface ${dir}: ${detail}. (ideal mean rank ${f2(mrIdeal)})`);
      break;
    case 'negative':
      console.log(`  Negative / no benefit — ${detail}.`);
      break;
    case 'mixed':
      console.log(`  Mixed — signals disagree or are negligible: ${detail}.`);
      break;
  }
  console.log('\n  "arrival(off)" = the order L2 sees with Semantic ranking OFF (≈ insertion order),');
  console.log("  so the arrival column also confirms the feature's off-path behavior is unchanged.");
  console.log('');

  db.close();
}

main();
