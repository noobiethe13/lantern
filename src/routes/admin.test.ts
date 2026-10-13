import { test, expect, beforeEach } from 'bun:test';
import { req, memDb, insertSource, insertJob, resetDb, WORK } from '../test-harness';
import { existsSync } from 'fs';
import { join } from 'path';

const ATT = join(WORK, 'data', 'attachments');
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x0a]);

beforeEach(() => {
  resetDb();
});

test('POST /api/admin/clear-jobs is rejected with 409 while a scan holds the lock', async () => {
  memDb.run('INSERT INTO scan_locks (key, acquired_at) VALUES (?, ?)', ['scan', Date.now()]);
  try {
    const res = await req('/api/admin/clear-jobs', { method: 'POST' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
  } finally {
    memDb.run('DELETE FROM scan_locks WHERE key = ?', ['scan']);
  }
});

test('POST /api/admin/clear-jobs removes attachment files from disk, not just DB rows', async () => {
  const src = insertSource();
  const job = insertJob(src);
  const fd = new FormData();
  fd.append('file', new File([PDF_BYTES], 'r.pdf', { type: 'application/pdf' }));
  const up = await req(`/api/attachments/${job}`, { method: 'POST', body: fd });
  const upBody = await up.json();
  expect(existsSync(join(ATT, upBody.stored))).toBe(true);

  const res = await req('/api/admin/clear-jobs', { method: 'POST' });
  expect(res.status).toBe(200);
  expect(existsSync(join(ATT, upBody.stored))).toBe(false);
  expect(memDb.query('SELECT * FROM attachments').all().length).toBe(0);
});

test('POST /api/admin/clear-jobs drops the cache of every board, since its stored jobs and sightings are gone', async () => {
  const src = insertSource({ last_ok_fetch_at: Date.now() });
  const job = insertJob(src);
  memDb.run('INSERT INTO board_sightings (source_id, job_id, seen_at) VALUES (?, ?, ?)', [src, job, Date.now()]);

  const res = await req('/api/admin/clear-jobs', { method: 'POST' });
  expect(res.status).toBe(200);
  expect(memDb.query('SELECT last_ok_fetch_at FROM sources WHERE id = ?').get(src)).toEqual({ last_ok_fetch_at: null });
  expect(memDb.query('SELECT COUNT(*) AS n FROM board_sightings').get()).toEqual({ n: 0 });
});
