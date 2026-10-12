import { describe, expect, test, beforeEach } from 'bun:test';
import { memDb, resetDb } from '../test-harness';

// ../test-harness already loaded server.ts, which pulls this module in for
// real via scan.ts, so this plain dynamic import resolves against the shared
// mocked db instead of a fresh module instance.
const { applyLegitimacyPass } = await import('./legitimacy');

beforeEach(() => {
  resetDb();
});

describe('applyLegitimacyPass', () => {
  test('scores every surfaced row in exactly one db.transaction (not one autocommit per row)', () => {
    const sourceId = memDb
      .query<{ id: number }, []>(
        "INSERT INTO sources (type, identifier, display_name, enabled, created_at) VALUES ('greenhouse','acme','Acme',1,0) RETURNING id"
      )
      .get()!.id;
    const runId = memDb.query<{ id: number }, []>('INSERT INTO runs (started_at) VALUES (0) RETURNING id').get()!.id;

    const insertJob = memDb.prepare(
      `INSERT INTO jobs (source_id, url, title, company, content_hash, first_seen, last_seen, last_run_id, jd_text)
       VALUES (?, ?, 'Engineer', 'Acme', ?, 0, 0, ?, ?)`,
    );
    const jd = 'A real job description. '.repeat(30);
    for (let i = 0; i < 5; i++) {
      insertJob.run(sourceId, `https://job-boards.greenhouse.io/acme/jobs/${i}`, `h${i}`, runId, jd);
    }

    let transactionCalls = 0;
    const realTransaction = memDb.transaction.bind(memDb);
    // @ts-expect-error -- test-only spy on the instance method
    memDb.transaction = (fn: () => void) => {
      transactionCalls++;
      return realTransaction(fn);
    };

    const scored = applyLegitimacyPass(runId);
    memDb.transaction = realTransaction; // restore for later tests in this file

    expect(scored).toBe(5);
    expect(transactionCalls).toBe(1);

    const rows = memDb
      .query<{ legitimacy: string | null }, []>('SELECT legitimacy FROM jobs')
      .all();
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(['high', 'caution', 'suspicious']).toContain(row.legitimacy!);
    }
  });

  test('only scores rows scoped to the given run', () => {
    const sourceId = memDb
      .query<{ id: number }, []>(
        "INSERT INTO sources (type, identifier, display_name, enabled, created_at) VALUES ('lever','globex','Globex',1,0) RETURNING id"
      )
      .get()!.id;
    const runIdA = memDb.query<{ id: number }, []>('INSERT INTO runs (started_at) VALUES (1) RETURNING id').get()!.id;
    const runIdB = memDb.query<{ id: number }, []>('INSERT INTO runs (started_at) VALUES (2) RETURNING id').get()!.id;

    memDb.run(
      `INSERT INTO jobs (source_id, url, title, company, content_hash, first_seen, last_seen, last_run_id)
       VALUES (?, 'https://jobs.lever.co/globex/a', 'A', 'Globex', 'ha', 0, 0, ?)`,
      [sourceId, runIdA],
    );
    memDb.run(
      `INSERT INTO jobs (source_id, url, title, company, content_hash, first_seen, last_seen, last_run_id)
       VALUES (?, 'https://jobs.lever.co/globex/b', 'B', 'Globex', 'hb', 0, 0, ?)`,
      [sourceId, runIdB],
    );

    const scored = applyLegitimacyPass(runIdB);
    expect(scored).toBe(1);
  });
});
