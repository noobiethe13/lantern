import { join } from 'path';
import { z } from 'zod';
import type { Criteria } from './filter';

// Local sentence-embedding substrate. Encoder, not a generative model — this is
// the deliberate, narrow exception to "Claude Code is the only LLM provider":
// it never generates text, only turns text into vectors for ranking/dedup. Runs
// on the ONNX CPU backend (onnxruntime-node, no GPU) — its prebuilt native binary
// ships in the package tarball and loads under Bun without a postinstall step.
// Default ON; the toggle (routes/embeddings.ts) skips loading the model entirely
// when off, so a default-off install downloads no weights.
//
// Pure helpers (cap, schema, cosine, (de)serialize) stay importable without the
// model or the DB; embedTexts() lazily pulls in transformers on first use.

export const EMBED_DIM = 384; // all-MiniLM-L6-v2 output width
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

// Cap embedded text. The model truncates at ~256 tokens anyway, and this is also
// an injection/length guard for scraped JD text fed into the encoder.
export const EMBED_TEXT_CHARS = 2_000;

export const EmbeddingSettingsSchema = z.object({ enabled: z.boolean() });
export type EmbeddingSettings = z.infer<typeof EmbeddingSettingsSchema>;
export const DEFAULT_EMBEDDING_SETTINGS: EmbeddingSettings = { enabled: true };

/** A compact anchor string for a search, built from the derived criteria, used
 * as the query vector for the L1.5 pre-ranker. Positive title keywords carry most
 * of the signal; seniority/location/remote add context the encoder can use. */
export function criteriaToQueryText(c: Criteria): string {
  const parts: string[] = [];
  if (c.title?.positive?.length) parts.push(...c.title.positive);
  if (c.seniority?.allowed?.length) parts.push(...c.seniority.allowed);
  if (c.location?.remote_required) parts.push('remote');
  if (c.location?.allowed?.length) parts.push(...c.location.allowed);
  return parts.join(', ').trim();
}

/** Dot product of two L2-normalized vectors === cosine similarity. Returns 0 on
 * a length mismatch (e.g. an old vector from a different model). */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/** Rank candidates by cosine similarity to a target vector, returning the top
 * `k` (descending). Pure — the caller pairs each vector with whatever payload it
 * wants back. A simple sort: candidate counts here are small (one machine's job
 * store), so an ANN index isn't warranted yet. */
export function topKSimilar<T>(
  target: Float32Array,
  candidates: { vec: Float32Array; item: T }[],
  k: number,
): { item: T; sim: number }[] {
  return candidates
    .map(({ vec, item }) => ({ item, sim: cosineSim(target, vec) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, Math.max(0, k));
}

/** Float32Array → Buffer for storage in a BLOB column, and back. Little-endian
 * via the underlying ArrayBuffer; deserialize copies so the row buffer can be
 * freed. Returns null if the byte length isn't a whole number of floats. */
export function serializeVector(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function deserializeVector(buf: Uint8Array | null | undefined): Float32Array | null {
  if (!buf || buf.byteLength === 0 || buf.byteLength % 4 !== 0) return null;
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}

// Lazy, single-flight model load. The first caller triggers the import + model
// fetch (~25MB, one-time, cached to models/); concurrent callers await the same
// promise. Typed loosely — transformers' types aren't worth importing eagerly.
type Extractor = (texts: string[], opts: Record<string, unknown>) => Promise<{ data: Float32Array; dims: number[] }>;
let extractorPromise: Promise<Extractor> | null = null;

async function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      // Cache weights to a stable, gitignored repo dir — NOT data/ (user data),
      // and not node_modules (wiped on reinstall).
      env.cacheDir = join(process.cwd(), 'models');
      // q8 quantized + CPU execution provider: deterministic, no GPU, ~95%
      // accuracy at ~1/4 the weight of the full-precision model.
      return (await pipeline('feature-extraction', MODEL_ID, {
        dtype: 'q8',
        device: 'cpu',
      })) as unknown as Extractor;
    })().catch((err) => {
      // Reset so a transient failure (e.g. offline first run) can retry next call
      // instead of being cached forever.
      extractorPromise = null;
      throw err;
    });
  }
  return extractorPromise;
}

/** Embed texts into L2-normalized 384-d vectors (mean-pooled). Batched in one
 * model call. Empty input short-circuits without loading the model. Throws if
 * the model can't load — callers treat embeddings as best-effort and degrade. */
export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  const capped = texts.map((t) => t.slice(0, EMBED_TEXT_CHARS));
  const out = await extractor(capped, { pooling: 'mean', normalize: true });
  const [n, dim] = out.dims;
  const result: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    result.push(out.data.slice(i * dim, (i + 1) * dim) as Float32Array);
  }
  return result;
}
