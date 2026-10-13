import { db } from '../db/client';
import { TITLE_MISSING_REASON, type Criteria } from '../core/filter';
import { criteriaToQueryText, embedTexts } from '../core/embed';
import {
  RESCUE_MAX_CANDIDATES,
  RESCUE_MAX_CENTROID_SURVIVORS,
  RESCUE_MAX_SURVIVORS_PER_COMPANY,
  RESCUE_MIN_JD_CHARS,
  chooseAnchor,
  selectRescues,
} from '../core/semantic-rescue';
import { ensureEmbeddings, type EmbeddableRow } from './embed-fill';
import { embeddingEnabled } from '../routes/embeddings';
import { bus } from './progress';

// L1.5 semantic rescue. The title rule drops "Software Engineer II" on a backend
// search even when the JD is all backend work. Between the L1 scan and L2, this pass
// re-admits the jobs whose ONLY L1 failure was the missing title keyword when their
// text embeds close to the search: to the centroid of this run's L1 survivors (real
// examples of what matched), or to the query anchor when there are too few. Unlike
// the pre-ranker it ADDS to the L2 queue, so it is capped (see core/semantic-rescue.ts
// for the operating point and why a false promotion is cheap). Embeddings are an
// enhancement: a disabled feature or any failure leaves L1's verdicts untouched.
//
// Jobs from enrich-capable adapters (LinkedIn, Rippling, Workday...) only get a JD
// after enrich(), which runs for L1 survivors only. Such a title-miss has no JD
// here and is not a candidate. Enriching rescue candidates is deliberately out of
// scope: it would spend per-job requests on jobs L1 already rejected.

/** Test seam so tests need not load the ONNX model. Production passes nothing. */
export interface RescueOptions {
  embedQuery?: (text: string) => Promise<Float32Array | undefined>;
}

const CANDIDATE_REASONS_JSON = JSON.stringify([TITLE_MISSING_REASON]);

const embedOne = async (text: string) => (await embedTexts([text]))[0];

/**
 * Promote this run's title-only L1 misses that are semantically close to the search.
 * Returns the number promoted. Idempotent per run: promoted jobs are l1_pass = 1 and
 * so are no longer candidates. Never throws.
 */
export async function applySemanticRescue(
  runId: number,
  criteria: Criteria,
  opts: RescueOptions = {},
): Promise<number> {
  try {
    if (!embeddingEnabled()) return 0;
    const queryText = criteriaToQueryText(criteria);
    if (queryText === '') return 0;

    // Candidates that already carry a vector are scored for free, so only rows still
    // needing an embedding count against RESCUE_MAX_CANDIDATES. Those are taken
    // newest-posted first (posted_at, else first_seen): once embedded they stop
    // consuming the budget, so older candidates are reached on later runs rather
    // than starved behind an ever-fresh stream.
    const candidateSql = `SELECT id, title, company, jd_text, embedding FROM jobs
       WHERE last_run_id = ? AND l1_pass = 0 AND l1_reasons = ? AND length(jd_text) >= ?`;
    const args = [runId, CANDIDATE_REASONS_JSON, RESCUE_MIN_JD_CHARS] as const;
    const cached = db.query<EmbeddableRow, [number, string, number]>(`${candidateSql} AND embedding IS NOT NULL`).all(...args);
    const fresh = db
      .query<EmbeddableRow, [number, string, number, number]>(
        `${candidateSql} AND embedding IS NULL ORDER BY COALESCE(posted_at, first_seen) DESC, id DESC LIMIT ?`,
      )
      .all(...args, RESCUE_MAX_CANDIDATES);
    const candidates = [...cached, ...fresh];
    if (candidates.length === 0) return 0;
    if (fresh.length === RESCUE_MAX_CANDIDATES) {
      console.log(`[semantic-rescue] embedding the newest ${fresh.length} candidates, the rest on a later run`);
    }

    // The centroid is built from the run's L1 survivors, at most a few per company
    // (see RESCUE_MAX_SURVIVORS_PER_COMPANY). The pre-ranker embeds them anyway, so
    // this shifts that work earlier rather than adding to it.
    const survivors = db
      .query<EmbeddableRow, [number, number, number]>(
        `SELECT id, title, company, jd_text, embedding FROM (
           SELECT id, title, company, jd_text, embedding,
                  ROW_NUMBER() OVER (PARTITION BY COALESCE(company_norm, '') ORDER BY id DESC) AS rn
           FROM jobs WHERE last_run_id = ? AND l1_pass = 1 AND l1_rescued = 0
         ) WHERE rn <= ? ORDER BY id DESC LIMIT ?`,
      )
      .all(runId, RESCUE_MAX_SURVIVORS_PER_COMPANY, RESCUE_MAX_CENTROID_SURVIVORS);

    const toEmbed = fresh.length + survivors.filter((r) => !r.embedding).length;
    const startMsg = `Semantic rescue: scoring ${candidates.length} candidates${toEmbed > 0 ? ` (embedding ${toEmbed})` : ''}…`;
    bus.emit({ runId, type: 'rescue_start', msg: startMsg, data: { candidates: candidates.length, embedding: toEmbed } });

    const survivorVecs = [...(await ensureEmbeddings(survivors)).values()];
    const anchor = chooseAnchor(survivorVecs, await (opts.embedQuery ?? embedOne)(queryText));
    if (!anchor) return 0;
    const vecById = await ensureEmbeddings(candidates);

    const scored = candidates.flatMap((row) => {
      const vec = vecById.get(row.id);
      return vec ? [{ vec, item: row.id }] : [];
    });
    const promoted = selectRescues(anchor, scored);
    if (promoted.length === 0) return 0;

    const promote = db.prepare('UPDATE jobs SET l1_pass = 1, l1_rescued = 1 WHERE id = ?');
    db.transaction(() => {
      for (const p of promoted) promote.run(p.item);
      db.run('UPDATE runs SET jobs_l1_pass = jobs_l1_pass + ? WHERE id = ?', [promoted.length, runId]);
    })();

    const msg = `Semantic rescue: ${promoted.length} job${promoted.length === 1 ? '' : 's'} promoted`;
    console.log(msg);
    bus.emit({ runId, type: 'rescue_done', msg, data: { promoted: promoted.length, considered: candidates.length, anchor: anchor.kind } });
    return promoted.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[semantic-rescue] skipped: ${msg}`);
    return 0;
  }
}
