import { describe, expect, test, mock, beforeEach } from 'bun:test';
// Real (unmocked) — captured before core/embed is mocked below, so the fake
// module can still serialize/deserialize real vectors without loading the ONNX
// model.
import { serializeVector, deserializeVector } from '../core/embed';
import { memDb, resetDb } from '../test-harness';
import type { EmbeddableRow } from './embed-fill';

const embedCallSizes: number[] = [];
mock.module('../core/embed', () => ({
  serializeVector,
  deserializeVector,
  embedTexts: async (texts: string[]): Promise<Float32Array[]> => {
    embedCallSizes.push(texts.length);
    return texts.map(() => new Float32Array(384));
  },
}));

// ../test-harness already loaded server.ts, which pulls this module in for
// real via scan.ts -> semantic-dedup.ts -> embed-fill.ts, so a plain (dynamic,
// for consistency with the mock.module ordering above) import resolves against
// the shared mocked db/core-embed rather than a fresh module instance.
const { ensureEmbeddings, EMBED_CHUNK_SIZE, jobEmbeddingText } = await import('./embed-fill');

beforeEach(() => {
  resetDb();
});

describe('ensureEmbeddings', () => {
  test('embeds missing rows in chunks no larger than EMBED_CHUNK_SIZE, persisting each chunk', async () => {
    const sourceId = memDb
      .query<{ id: number }, []>(
        "INSERT INTO sources (type, identifier, display_name, enabled, created_at) VALUES ('greenhouse','acme','Acme',1,0) RETURNING id",
      )
      .get()!.id;

    const insertJob = memDb.prepare(
      `INSERT INTO jobs (id, source_id, url, title, company, content_hash, first_seen, last_seen)
       VALUES (?, ?, ?, ?, 'Acme', ?, 0, 0)`,
    );
    const N = 100;
    const rows: EmbeddableRow[] = [];
    memDb.transaction(() => {
      for (let i = 1; i <= N; i++) {
        insertJob.run(i, sourceId, `https://job-boards.greenhouse.io/acme/jobs/${i}`, `Engineer ${i}`, `h${i}`);
        rows.push({ id: i, title: `Engineer ${i}`, company: 'Acme', jd_text: null, embedding: null });
      }
    })();

    const vecById = await ensureEmbeddings(rows);

    expect(vecById.size).toBe(N);
    expect(embedCallSizes.length).toBeGreaterThan(1); // proves it actually chunked, not one big call
    for (const size of embedCallSizes) expect(size).toBeLessThanOrEqual(EMBED_CHUNK_SIZE);
    expect(embedCallSizes.reduce((a, b) => a + b, 0)).toBe(N);

    const persisted = memDb
      .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM jobs WHERE embedding IS NOT NULL')
      .get();
    expect(persisted?.n).toBe(N);
  });

  test('rows that already carry an embedding are never re-embedded', async () => {
    embedCallSizes.length = 0;
    const sourceId = memDb
      .query<{ id: number }, []>(
        "INSERT INTO sources (type, identifier, display_name, enabled, created_at) VALUES ('lever','globex','Globex',1,0) RETURNING id",
      )
      .get()!.id;
    const v = new Float32Array(384);
    v[0] = 1;
    const blob = serializeVector(v);
    memDb.run(
      `INSERT INTO jobs (id, source_id, url, title, company, content_hash, first_seen, last_seen, embedding)
       VALUES (1000, ?, 'https://jobs.lever.co/globex/a', 'Cached Engineer', 'Globex', 'hcached', 0, 0, ?)`,
      [sourceId, blob],
    );

    const row = { id: 1000, title: 'Cached Engineer', company: 'Globex', jd_text: null, embedding: blob };
    const vecById = await ensureEmbeddings([row]);

    expect(embedCallSizes).toEqual([]); // no embedTexts call at all
    expect(vecById.get(1000)).toEqual(v);
  });

  test('jobEmbeddingText joins title/company/jd_text and drops empty parts', () => {
    expect(jobEmbeddingText({ id: 1, title: 'Engineer', company: 'Acme', jd_text: null, embedding: null }))
      .toBe('Engineer\nAcme');
    expect(jobEmbeddingText({ id: 1, title: 'Engineer', company: 'Acme', jd_text: 'Build things', embedding: null }))
      .toBe('Engineer\nAcme\nBuild things');
  });
});
