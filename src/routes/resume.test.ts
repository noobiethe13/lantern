import { test, expect, beforeEach } from 'bun:test';
import { req, memDb, resetDb } from '../test-harness';

beforeEach(() => {
  resetDb();
});

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x0a]); // "%PDF-\n"

test('PUT /api/settings/resume with an invalid body returns a readable C3 error', async () => {
  const res = await req('/api/settings/resume', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: 'yes', text: 123 }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(typeof body.error).toBe('string');
  expect(body.error).not.toContain('[object');
});

test('PUT /api/settings/resume is rejected with 409 while a scan holds the lock', async () => {
  memDb.run('INSERT INTO scan_locks (key, acquired_at) VALUES (?, ?)', ['scan', Date.now()]);
  try {
    const res = await req('/api/settings/resume', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, text: 'Rust, 10y backend' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
  } finally {
    memDb.run('DELETE FROM scan_locks WHERE key = ?', ['scan']);
  }
});

test('PUT /api/settings/resume succeeds once the scan lock is released', async () => {
  const res = await req('/api/settings/resume', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, text: 'Rust, 10y backend' }),
  });
  expect(res.status).toBe(200);
});

test('POST /extract: HTML declared as application/pdf is rejected by the magic-byte sniff', async () => {
  const fd = new FormData();
  fd.append('file', new File(['not a pdf'], 'r.pdf', { type: 'application/pdf' }));
  const res = await req('/api/settings/resume/extract', { method: 'POST', body: fd });
  expect(res.status).toBe(415);
});

test('POST /extract: malformed multipart body returns 400', async () => {
  const res = await req('/api/settings/resume/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=zzz' },
    body: 'garbage',
  });
  expect(res.status).toBe(400);
});

test('POST /extract: wrong declared type returns 415', async () => {
  const fd = new FormData();
  fd.append('file', new File(['x'], 'r.txt', { type: 'text/plain' }));
  const res = await req('/api/settings/resume/extract', { method: 'POST', body: fd });
  expect(res.status).toBe(415);
});
