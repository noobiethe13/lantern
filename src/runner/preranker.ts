import { cosineSim, embedTexts } from '../core/embed';
import { ensureEmbeddings } from './embed-fill';
import { embeddingEnabled } from '../routes/embeddings';
import type { L2JobRow } from './scan';

// L1.5 semantic pre-ranker. Between L1 and L2 it orders the L1 survivors so the
// expensive sequential L2 pass scores the most query-relevant jobs first. This is
// REORDER-ONLY — it never drops a job — so a wrong similarity score costs at most
// a worse queue position, never a missed match. Any failure (model can't load,
// etc.) falls back to the original order: embeddings are an enhancement, never a
// gate on L2.

/**
 * Return the L1 survivors reordered most-relevant-first. No-ops (returns the
 * input order) when the feature is disabled, there's nothing to reorder, or the
 * query anchor is empty. Embeds any survivor missing a cached vector and persists
 * it (embed-once), so re-scans reuse the stored embedding.
 */
export async function prerankSurvivors(jobs: L2JobRow[], queryText: string): Promise<L2JobRow[]> {
  if (!embeddingEnabled() || jobs.length <= 1 || queryText.trim() === '') return jobs;

  try {
    const vecById = await ensureEmbeddings(jobs);
    const [queryVec] = await embedTexts([queryText]);
    if (!queryVec) return jobs;

    // Stable sort by descending cosine; a job with no vector (shouldn't happen
    // after the fill above) sinks to the bottom rather than throwing.
    return [...jobs].sort((a, b) => {
      const va = vecById.get(a.id);
      const vb = vecById.get(b.id);
      const sa = va ? cosineSim(queryVec, va) : -Infinity;
      const sb = vb ? cosineSim(queryVec, vb) : -Infinity;
      return sb - sa;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[preranker] skipped — embeddings unavailable: ${msg}`);
    return jobs;
  }
}
