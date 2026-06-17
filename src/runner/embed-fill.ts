import { db } from '../db/client';
import { deserializeVector, embedTexts, serializeVector } from '../core/embed';

// Shared embed-once fill for the runner passes that need cached job vectors (the
// L1.5 pre-ranker and semantic dedup). Both reorder/cluster L1 survivors by
// embedding, and both must embed any survivor that doesn't yet carry a vector —
// using the SAME text shape, or the same job could get two different stored
// vectors depending on which pass embeds it first. Keeping that shape and the
// persist-once logic in one place removes that drift hazard.

export interface EmbeddableRow {
  id: number;
  title: string;
  company: string;
  jd_text: string | null;
  embedding: Uint8Array | null;
}

/** The canonical text a job is embedded from. Title + company + JD; empty parts
 * dropped so a missing field doesn't inject blank lines. */
export function jobEmbeddingText(row: EmbeddableRow): string {
  return [row.title, row.company, row.jd_text ?? ''].filter(Boolean).join('\n');
}

/**
 * Resolve id → vector for the given rows, embedding (and persisting, embed-once)
 * any that lack a cached embedding BLOB. The missing rows are embedded in one
 * batched `embedTexts` call and written back in a single transaction, so a
 * re-scan reuses the stored vectors. Throws if the model can't load — callers
 * treat embeddings as best-effort and fall back.
 */
export async function ensureEmbeddings(rows: EmbeddableRow[]): Promise<Map<number, Float32Array>> {
  const vecById = new Map<number, Float32Array>();
  const missing: EmbeddableRow[] = [];
  for (const row of rows) {
    const vec = deserializeVector(row.embedding);
    if (vec) vecById.set(row.id, vec);
    else missing.push(row);
  }

  if (missing.length > 0) {
    const vecs = await embedTexts(missing.map(jobEmbeddingText));
    const persist = db.prepare('UPDATE jobs SET embedding = ? WHERE id = ?');
    const tx = db.transaction((pairs: { id: number; vec: Float32Array }[]) => {
      for (const p of pairs) persist.run(serializeVector(p.vec), p.id);
    });
    const pairs = missing.map((row, i) => ({ id: row.id, vec: vecs[i] }));
    tx(pairs);
    for (const p of pairs) vecById.set(p.id, p.vec);
  }

  return vecById;
}
