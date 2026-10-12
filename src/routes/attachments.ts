import { Hono } from 'hono';
import { join, basename, resolve, sep } from 'path';
import { mkdirSync, unlinkSync } from 'fs';
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

// The client-declared MIME type is just a request header — HTML bytes can be
// labelled application/pdf. Sniff the real format from its magic bytes before
// trusting `file.type`; each check only needs the first few bytes of `buf`.
function matchesDeclaredType(type: string, buf: Uint8Array): boolean {
  switch (type) {
    case 'application/pdf':
      return buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d; // %PDF-
    case 'image/png':
      return buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a;
    case 'image/jpeg':
      return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case 'image/webp':
      return buf.length >= 12
        && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 // "RIFF"
        && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50; // "WEBP"
    default:
      return false;
  }
}

// Removes an attachment's file from disk given the DB-stored filename. The
// filename is server-generated (safeName() at upload time) but re-derive it
// with basename() and confirm the resolved path stays inside ATTACHMENTS_DIR
// before unlinking, in case a row is ever tampered with directly. ENOENT
// (already gone) is not an error; anything else is logged, not swallowed.
export function unlinkAttachment(storedPath: string): void {
  const resolvedDir = resolve(ATTACHMENTS_DIR);
  const target = resolve(resolvedDir, basename(storedPath));
  if (target !== resolvedDir && !target.startsWith(resolvedDir + sep)) return;
  try {
    unlinkSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.error(`Failed to remove attachment file ${target}:`, err);
    }
  }
}

attachments.post('/:jobId', async c => {
  const jobId = Number(c.req.param('jobId'));

  const job = db.query<{ id: number }, [number]>('SELECT id FROM jobs WHERE id = ?').get(jobId);
  if (!job) return c.json({ error: 'Job not found' }, 404);

  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'Malformed multipart body' }, 400);
  const file = form.get('file');
  const kind = String(form.get('kind') ?? 'other');

  if (!(file instanceof File)) return c.json({ error: 'No file provided' }, 400);
  if (!ALLOWED_TYPES.has(file.type)) return c.json({ error: 'Invalid file type' }, 415);
  if (file.size > MAX_SIZE) return c.json({ error: 'File too large (10MB max)' }, 413);
  if (!['resume', 'cover_letter', 'other'].includes(kind)) {
    return c.json({ error: 'Invalid kind' }, 400);
  }

  const buf = new Uint8Array(await file.arrayBuffer());
  if (!matchesDeclaredType(file.type, buf)) {
    return c.json({ error: 'File content does not match declared type' }, 415);
  }

  const safeFilename = safeName(file.name);
  const stored = `${jobId}_${Date.now()}_${safeFilename}`;
  const fullPath = join(ATTACHMENTS_DIR, stored);

  mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  await Bun.write(fullPath, buf);

  const sha = new Bun.CryptoHasher('sha256');
  sha.update(buf);
  const sha256 = sha.digest('hex');

  const result = db.query<{ id: number }, [number, string, string, string, string, number, number]>(
    `INSERT INTO attachments (job_id, kind, filename, stored_path, sha256, size_bytes, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).get(jobId, kind, safeFilename, stored, sha256, buf.byteLength, Date.now());

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
  const id = Number(c.req.param('id'));
  const row = db.query<{ stored_path: string }, [number]>('SELECT stored_path FROM attachments WHERE id = ?').get(id);
  db.run('DELETE FROM attachments WHERE id = ?', [id]);
  if (row) unlinkAttachment(row.stored_path);
  return c.json({ ok: true });
});
