import { test, expect, beforeEach } from 'bun:test';
import { req, insertSource, insertJob, resetDb, WORK } from '../test-harness';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

const ATT = join(WORK, 'data', 'attachments');

beforeEach(() => {
  resetDb();
});

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x0a]); // "%PDF-\n"

test('upload + DELETE: traversal-safe filename, and the file is unlinked from disk', async () => {
  const src = insertSource();
  const job = insertJob(src);
  const fd = new FormData();
  fd.append('file', new File([PDF_BYTES], '..\\..\\..\\evil name.pdf', { type: 'application/pdf' }));
  fd.append('kind', 'resume');
  const r = await req(`/api/attachments/${job}`, { method: 'POST', body: fd });
  expect(r.status).toBe(201);
  const body = await r.json();
  expect(body.stored).not.toContain('..');
  expect(existsSync(join(ATT, body.stored))).toBe(true);

  const d = await req(`/api/attachments/${body.id}`, { method: 'DELETE' });
  expect(d.status).toBe(200);
  expect(existsSync(join(ATT, body.stored))).toBe(false);
});

test('DELETE on an unknown attachment id is a no-op, not an error', async () => {
  const r = await req('/api/attachments/999999', { method: 'DELETE' });
  expect(r.status).toBe(200);
});

test('HTML bytes declared as application/pdf are rejected (magic-byte sniff)', async () => {
  const src = insertSource();
  const job = insertJob(src);
  const fd = new FormData();
  fd.append('file', new File(['<script>alert(1)</script>'], 'x.pdf', { type: 'application/pdf' }));
  const r = await req(`/api/attachments/${job}`, { method: 'POST', body: fd });
  expect(r.status).toBe(415);
});

test('a real PDF passes the magic-byte sniff', async () => {
  const src = insertSource();
  const job = insertJob(src);
  const fd = new FormData();
  fd.append('file', new File([PDF_BYTES], 'r.pdf', { type: 'application/pdf' }));
  const r = await req(`/api/attachments/${job}`, { method: 'POST', body: fd });
  expect(r.status).toBe(201);
});

test('malformed multipart body returns 400, not 500', async () => {
  const src = insertSource();
  const job = insertJob(src);
  const r = await req(`/api/attachments/${job}`, {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=zzz' },
    body: 'garbage-not-actually-multipart',
  });
  expect(r.status).toBe(400);
});

test('attachments dir does not accumulate files that were never a valid upload', async () => {
  const before = existsSync(ATT) ? readdirSync(ATT).length : 0;
  const src = insertSource();
  const job = insertJob(src);
  const fd = new FormData();
  fd.append('file', new File(['not a pdf'], 'x.pdf', { type: 'application/pdf' }));
  await req(`/api/attachments/${job}`, { method: 'POST', body: fd });
  const after = existsSync(ATT) ? readdirSync(ATT).length : 0;
  expect(after).toBe(before);
});
