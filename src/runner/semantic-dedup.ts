import { db } from '../db/client';
import { clusterDuplicates, type DedupItem } from '../core/semantic-dedup';
import { ensureEmbeddings } from './embed-fill';
import { embeddingEnabled } from '../routes/embeddings';

// Semantic de-duplication pass. Runs between the scan and L2 (in runFull),
// AFTER the legitimacy pass and BEFORE L2 so duplicates can be skipped by the
// expensive scoring pass. Reorder-safe but NOT a reorder: it marks each
// near-duplicate posting with the canonical id it folds into (jobs.duplicate_of),
// keeps the row (never deletes — consistent with the rest of lantern), and
// appends the duplicate's URL to the canonical's duplicate_urls so it still shows
// up under "also posted at". Any failure leaves the run un-deduped (best-effort,
// like the pre-ranker) — never blocks L2.

interface DedupRow {
  id: number;
  company_norm: string | null;
  title: string;
  company: string;
  jd_text: string | null;
  url: string;
  salary_min_usd: number | null;
  salary_max_usd: number | null;
  embedding: Uint8Array | null;
  duplicate_urls: string | null;
}

// Canonical preference: a posting that carries more information is the better one
// to keep and score. JD presence dominates a disclosed salary; ties fall back to
// the lowest id inside clusterDuplicates.
function priority(row: DedupRow): number {
  const hasJd = (row.jd_text ?? '').trim().length > 0 ? 2 : 0;
  const hasSalary = row.salary_min_usd !== null || row.salary_max_usd !== null ? 1 : 0;
  return hasJd + hasSalary;
}

/**
 * De-duplicate the L1 survivors a run surfaced. Returns the number of postings
 * marked as duplicates. No-op when the embedding feature is off (embeddings are
 * the signal). Idempotent per run: clears this run's survivors' duplicate_of
 * first, then recomputes, so a re-scan re-evaluates cleanly.
 */
export async function applySemanticDedupPass(runId: number): Promise<number> {
  // Reset this run's prior duplicate marks unconditionally — before the feature
  // gate — so a re-scan re-evaluates cleanly AND so disabling Semantic ranking
  // un-hides postings a previous pass had folded in (upsertJob re-stamps
  // last_run_id on re-surfaced jobs, bringing them back into this scope).
  db.run('UPDATE jobs SET duplicate_of = NULL WHERE last_run_id = ? AND duplicate_of IS NOT NULL', [runId]);

  if (!embeddingEnabled()) return 0;

  const survivors = db
    .query<DedupRow, [number]>(
      `SELECT id, company_norm, title, company, jd_text, url,
              salary_min_usd, salary_max_usd, embedding, duplicate_urls
       FROM jobs
       WHERE l1_pass = 1 AND last_run_id = ?`,
    )
    .all(runId);

  // Only postings that share a normalized company with at least one other
  // survivor can possibly be duplicates (same-company guard). Embedding the rest
  // here would be wasted work — the pre-ranker embeds them later anyway.
  const companyCounts = new Map<string, number>();
  for (const row of survivors) {
    if (row.company_norm) companyCounts.set(row.company_norm, (companyCounts.get(row.company_norm) ?? 0) + 1);
  }
  const candidates = survivors.filter(r => r.company_norm && companyCounts.get(r.company_norm)! > 1);
  if (candidates.length === 0) return 0;

  try {
    const vecById = await ensureEmbeddings(candidates);

    const items: DedupItem[] = candidates
      .map(row => {
        const vec = vecById.get(row.id);
        return vec ? { id: row.id, companyNorm: row.company_norm ?? '', vec, priority: priority(row) } : null;
      })
      .filter((it): it is DedupItem => it !== null);

    const clusters = clusterDuplicates(items);
    if (clusters.length === 0) return 0;

    const rowById = new Map(candidates.map(r => [r.id, r]));
    const markDup = db.prepare('UPDATE jobs SET duplicate_of = ? WHERE id = ?');
    const setCanonUrls = db.prepare('UPDATE jobs SET duplicate_urls = ? WHERE id = ?');

    let marked = 0;
    const apply = db.transaction(() => {
      for (const cluster of clusters) {
        const canon = rowById.get(cluster.canonicalId);
        const urls: string[] = canon?.duplicate_urls ? JSON.parse(canon.duplicate_urls) : [];
        for (const dupId of cluster.duplicateIds) {
          markDup.run(cluster.canonicalId, dupId);
          marked++;
          const dup = rowById.get(dupId);
          if (!dup) continue;
          // Fold the duplicate's own URL AND any it already accumulated (e.g. from
          // lexical fuzzy-merge in upsertJob) into the canonical's "also posted at"
          // set, so collapsing the row doesn't lose those links.
          const dupUrls = [dup.url, ...(dup.duplicate_urls ? JSON.parse(dup.duplicate_urls) as string[] : [])];
          for (const u of dupUrls) {
            if (u && u !== canon?.url && !urls.includes(u)) urls.push(u);
          }
        }
        if (canon) setCanonUrls.run(urls.length > 0 ? JSON.stringify(urls) : null, canon.id);
      }
    });
    apply();
    return marked;
  } catch (err) {
    // Best-effort: any failure (model can't load, a write error) leaves the run
    // un-deduped rather than aborting the scan. Don't assert the cause in the log
    // — this block also wraps the clustering and the mark/URL-merge writes.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[semantic-dedup] skipped: ${msg}`);
    return 0;
  }
}
