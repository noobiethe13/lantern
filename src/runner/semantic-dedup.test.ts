import { describe, expect, test, beforeEach } from 'bun:test';
import { memDb, resetDb } from '../test-harness';

// ../test-harness already loaded server.ts, which pulls this module in for
// real via scan.ts, so these plain dynamic imports resolve against the shared
// mocked db instead of a fresh module instance. embeddings are enabled by
// default (resetDb() clears the settings table each test, same as "no
// settings row"), and every job below carries a pre-populated `embedding`
// BLOB so ensureEmbeddings never needs the real ONNX model.
const { serializeVector } = await import('../core/embed');
const { applySemanticDedupPass } = await import('./semantic-dedup');

beforeEach(() => {
  resetDb();
});

function unitVec(): Uint8Array {
  const v = new Float32Array(384);
  v[0] = 1;
  return serializeVector(v);
}

function jobsSnapshot(): { id: number; status: string; duplicate_of: number | null }[] {
  return memDb
    .query<{ id: number; status: string; duplicate_of: number | null }, []>(
      'SELECT id, status, duplicate_of FROM jobs ORDER BY id',
    )
    .all();
}

describe('applySemanticDedupPass — triaged rows are never hidden', () => {
  test('an applied row (with notes) is preferred canonical over an untriaged near-duplicate', async () => {
    const sourceId1 = memDb
      .query<{ id: number }, []>(
        "INSERT INTO sources (type, identifier, display_name, enabled, created_at) VALUES ('greenhouse','acme','Acme',1,0) RETURNING id",
      )
      .get()!.id;
    const sourceId2 = memDb
      .query<{ id: number }, []>(
        "INSERT INTO sources (type, identifier, display_name, enabled, created_at) VALUES ('lever','acme','Acme',1,0) RETURNING id",
      )
      .get()!.id;
    const runId = memDb.query<{ id: number }, []>('INSERT INTO runs (started_at) VALUES (0) RETURNING id').get()!.id;

    const jd = 'Build payments infra. '.repeat(40);
    const blob = unitVec();

    memDb.run(
      `INSERT INTO jobs (id, source_id, url, title, company, company_norm, jd_text, content_hash, first_seen, last_seen, l1_pass, last_run_id, embedding, status)
       VALUES (10, ?, 'https://job-boards.greenhouse.io/acme/jobs/1', 'Backend Engineer, Payments', 'Acme', 'acme', ?, 'h1', 0, 0, 1, ?, ?, 'new')`,
      [sourceId1, jd, runId, blob],
    );
    memDb.run(
      `INSERT INTO jobs (id, source_id, url, title, company, company_norm, jd_text, content_hash, first_seen, last_seen, l1_pass, last_run_id, embedding, status, notes, applied_at)
       VALUES (50, ?, 'https://jobs.lever.co/acme/abc', 'Software Engineer - Payments Platform', 'Acme', 'acme', ?, 'h2', 0, 0, 1, ?, ?, 'applied', 'phone screen Tue', 123)`,
      [sourceId2, jd, runId, blob],
    );

    const marked = await applySemanticDedupPass(runId);
    expect(marked).toBe(1);
    expect(jobsSnapshot()).toEqual([
      { id: 10, status: 'new', duplicate_of: 50 },
      { id: 50, status: 'applied', duplicate_of: null },
    ]);
  });

  test('notes-only and attachment-only triage also block folding, even when status stays "new"', async () => {
    const sourceId = memDb
      .query<{ id: number }, []>(
        "INSERT INTO sources (type, identifier, display_name, enabled, created_at) VALUES ('greenhouse','globex','Globex',1,0) RETURNING id",
      )
      .get()!.id;
    const runId = memDb.query<{ id: number }, []>('INSERT INTO runs (started_at) VALUES (1) RETURNING id').get()!.id;

    const jd = 'Build the widget platform. '.repeat(40);
    const blob = unitVec();
    const insertJob = memDb.prepare(
      `INSERT INTO jobs (id, source_id, url, title, company, company_norm, jd_text, content_hash, first_seen, last_seen, l1_pass, last_run_id, embedding, status, notes)
       VALUES (?, ?, ?, ?, 'Globex', 'globex', ?, ?, 0, 0, 1, ?, ?, 'new', ?)`,
    );
    insertJob.run(1, sourceId, 'https://job-boards.greenhouse.io/globex/jobs/1', 'Widget Engineer', jd, 'h3', runId, blob, 'phone screen booked'); // notes-triaged
    insertJob.run(2, sourceId, 'https://job-boards.greenhouse.io/globex/jobs/2', 'Widget Engineer', jd, 'h4', runId, blob, null); // attachment-triaged
    insertJob.run(3, sourceId, 'https://job-boards.greenhouse.io/globex/jobs/3', 'Widget Engineer', jd, 'h5', runId, blob, null); // plain untriaged
    memDb.run(
      `INSERT INTO attachments (job_id, kind, filename, stored_path, sha256, size_bytes, uploaded_at)
       VALUES (2, 'resume', 'resume.pdf', '/tmp/resume.pdf', 'deadbeef', 100, 0)`,
    );

    const marked = await applySemanticDedupPass(runId);
    // Only the untriaged row (id 3) may be folded; it attaches to whichever
    // triaged row was processed first (id 1, notes) as canonical.
    expect(marked).toBe(1);
    const rows = jobsSnapshot();
    expect(rows.find(r => r.id === 1)?.duplicate_of).toBeNull(); // notes-triaged: canonical
    expect(rows.find(r => r.id === 2)?.duplicate_of).toBeNull(); // attachment-triaged: never folded
    expect(rows.find(r => r.id === 3)?.duplicate_of).toBe(1); // untriaged: folded into a triaged row
  });
});
