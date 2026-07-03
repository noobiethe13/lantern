import { Hono } from 'hono';
import { join, basename } from 'path';
import { mkdirSync } from 'fs';
import { db } from '../db/client';

export const attachments = new Hono();

const ATTACHMENTS_DIR = join(process.cwd(), 'data', 'attachments');
const ALLOWED_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
]);
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

function safeName(raw: string): string {
  // Prevent path traversal — take only the filename, then sanitize
  return basename(raw).replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 200) || 'file';
}

attachments.post('/:jobId', async c => {
  const jobId = Number(c.req.param('jobId'));

  const job = db.query<{ id: number }, [number]>('SELECT id FROM jobs WHERE id = ?').get(jobId);
  if (!job) return c.json({ error: 'Job not found' }, 404);

  const form = await c.req.formData();
  const file = form.get('file');
  const kind = String(form.get('kind') ?? 'other');

  if (!(file instanceof File)) return c.json({ error: 'No file provided' }, 400);
  if (!ALLOWED_TYPES.has(file.type)) return c.json({ error: 'Invalid file type' }, 415);
  if (file.size > MAX_SIZE) return c.json({ error: 'File too large (10MB max)' }, 413);
  if (!['resume', 'cover_letter', 'other'].includes(kind)) {
    return c.json({ error: 'Invalid kind' }, 400);
  }

  const safeFilename = safeName(file.name);
  const stored = `${jobId}_${Date.now()}_${safeFilename}`;
  const fullPath = join(ATTACHMENTS_DIR, stored);

  mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  await Bun.write(fullPath, await file.arrayBuffer());

  const sha = new Bun.CryptoHasher('sha256');
  sha.update(await file.arrayBuffer());
  const sha256 = sha.digest('hex');

  const result = db.query<{ id: number }, [number, string, string, string, string, number, number]>(
    `INSERT INTO attachments (job_id, kind, filename, stored_path, sha256, size_bytes, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).get(jobId, kind, safeFilename, stored, sha256, file.size, Date.now());

  return c.json({ id: result!.id, filename: safeFilename, stored }, 201);
});

attachments.get('/job/:jobId', c => {
  const jobId = Number(c.req.param('jobId'));
  const rows = db.query<Record<string, unknown>, [number]>(
    'SELECT * FROM attachments WHERE job_id = ? ORDER BY uploaded_at DESC'
  ).all(jobId);
  return c.json({ attachments: rows });
});

attachments.delete('/:id', c => {
  db.run('DELETE FROM attachments WHERE id = ?', [Number(c.req.param('id'))]);
  return c.json({ ok: true });
});
