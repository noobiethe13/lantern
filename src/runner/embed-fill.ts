import { db } from '../db/client';
import { deserializeVector, embedTexts, serializeVector } from '../core/embed';

// Shared embed-once fill for the runner passes that need cached job vectors (the
// L1.5 pre-ranker and semantic dedup). Both reorder/cluster L1 survivors by
// embedding, and both must embed any survivor that doesn't yet carry a vector —
// using the SAME text shape, or the same job could get two different stored
// vectors depending on which pass embeds it first. Keeping that shape and the
// persist-once logic in one place removes that drift hazard.

// Texts per embedTexts() call for the missing-row backfill below. The ONNX
// forward pass pads every text in a batch to the longest one and holds
// intermediate tensors for the whole batch at once — peak memory scales
// ~linearly with batch size (measured ≈13 MB/text), so embedding e.g. 1,000
// un-embedded survivors in ONE call can need 6-13 GB and get OOM-killed on a
// first big run. A fixed chunk size caps peak memory regardless of how many
// rows are missing.
export const EMBED_CHUNK_SIZE = 32;

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
 * any that lack a cached embedding BLOB. Missing rows are embedded and persisted
 * in chunks of {@link EMBED_CHUNK_SIZE} (one `embedTexts` call + one transaction
 * per chunk) rather than a single all-at-once pass, so a big first run bounds its
 * peak memory AND survives a later failure — vectors from earlier chunks are
 * already committed by the time a later chunk throws, so a re-scan resumes
 * instead of re-embedding everything. Throws if the model can't load (on the
 * first chunk) or a later chunk fails — callers treat embeddings as best-effort
 * and fall back.
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
    const persist = db.prepare('UPDATE jobs SET embedding = ? WHERE id = ?');
    const persistChunk = db.transaction((pairs: { id: number; vec: Float32Array }[]) => {
      for (const p of pairs) persist.run(serializeVector(p.vec), p.id);
    });

    for (let i = 0; i < missing.length; i += EMBED_CHUNK_SIZE) {
      const chunk = missing.slice(i, i + EMBED_CHUNK_SIZE);
      const vecs = await embedTexts(chunk.map(jobEmbeddingText));
      const pairs = chunk.map((row, j) => ({ id: row.id, vec: vecs[j] }));
      persistChunk(pairs);
      for (const p of pairs) vecById.set(p.id, p.vec);
    }
  }

  return vecById;
}
