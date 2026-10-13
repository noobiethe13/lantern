import { cosineSim, embedTexts } from '../core/embed';
import { ensureEmbeddings } from './embed-fill';
import { embeddingEnabled } from '../routes/embeddings';
import { preferenceAdjustments } from '../core/preference';
import { loadPreferenceModel } from './preference';
import type { L2JobRow } from './scan';

// L1.5 semantic pre-ranker. Between L1 and L2 it orders the L1 survivors so the
// expensive sequential L2 pass scores the most query-relevant jobs first. This is
// REORDER-ONLY — it never drops a job — so a wrong similarity score costs at most
// a worse queue position, never a missed match. Any failure (model can't load,
// etc.) falls back to the original order: embeddings are an enhancement, never a
// gate on L2.

/** Test seam so tests need not load the ONNX model. Production passes nothing. */
export interface PrerankOptions {
  embedQuery?: (text: string) => Promise<Float32Array | undefined>;
}

const embedOne = async (text: string) => (await embedTexts([text]))[0];

/**
 * Return the L1 survivors reordered most-relevant-first. No-ops (returns the
 * input order) when the feature is disabled, there's nothing to reorder, or the
 * query anchor is empty. Embeds any survivor missing a cached vector and persists
 * it (embed-once), so re-scans reuse the stored embedding.
 */
export async function prerankSurvivors(
  jobs: L2JobRow[],
  queryText: string,
  opts: PrerankOptions = {},
): Promise<L2JobRow[]> {
  if (!embeddingEnabled() || jobs.length <= 1 || queryText.trim() === '') return jobs;

  try {
    const vecById = await ensureEmbeddings(jobs);
    const queryVec = await (opts.embedQuery ?? embedOne)(queryText);
    if (!queryVec) return jobs;

    // Learned taste (shortlisted/dismissed jobs) nudges the order so liked-looking
    // jobs are graded first. Bounded and reorder-only, like the rest of this pass.
    const model = loadPreferenceModel();
    const adjust = model
      ? preferenceAdjustments(model, jobs.map((j) => ({ id: j.id, vec: vecById.get(j.id) })))
      : new Map<number, number>();

    // Stable sort by descending cosine (+ taste delta); a job with no vector
    // (shouldn't happen after the fill above) sinks to the bottom rather than throwing.
    const scores = new Map<number, number>();
    for (const j of jobs) {
      const v = vecById.get(j.id);
      scores.set(j.id, v ? cosineSim(queryVec, v) + (adjust.get(j.id) ?? 0) : -Infinity);
    }
    return [...jobs].sort((a, b) => {
      const sa = scores.get(a.id)!;
      const sb = scores.get(b.id)!;
      return sa === sb ? 0 : sb - sa; // -Infinity - -Infinity would be NaN
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[preranker] skipped — embeddings unavailable: ${msg}`);
    return jobs;
  }
}
