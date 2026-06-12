import { Hono } from 'hono';
import { db } from '../db/client';
import { extractPdfText } from '../core/pdf';
import {
  DEFAULT_RESUME_SETTINGS,
  RESUME_TEXT_MAX,
  ResumeSettingsSchema,
  resumeChangeAffectsVerdicts,
  type ResumeSettings,
} from '../core/resume';

export const resumeSettings = new Hono();

// Master/baseline resume for triage scoring (L2 background-fit). Stored as
// TEXT in the settings KV — per-job attachments are apply-stage documents and
// the wrong place for it. PDFs are transient: extracted to text, returned to
// the client for review, never persisted.
const PDF_MAX_SIZE = 10 * 1024 * 1024; // matches attachments cap

export function readResumeSettings(): ResumeSettings {
  const row = db
    .query<{ value_json: string }, []>("SELECT value_json FROM settings WHERE key = 'resume'")
    .get();
  if (!row) return DEFAULT_RESUME_SETTINGS;
  const parsed = ResumeSettingsSchema.safeParse(JSON.parse(row.value_json));
  return parsed.success ? parsed.data : DEFAULT_RESUME_SETTINGS;
}

/**
 * The resume text L2 should grade against, or null when the feature is off
 * or no text is saved. Used by the runner; reading here keeps the settings
 * row format private to this module.
 */
export function activeResumeText(): string | null {
  const s = readResumeSettings();
  const text = s.text.trim();
  return s.enabled && text ? text : null;
}

resumeSettings.get('/', c => {
  return c.json({ settings: readResumeSettings() });
});

resumeSettings.put('/', async c => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = ResumeSettingsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

  const prev = readResumeSettings();
  db.run(
    `INSERT INTO settings (key, value_json, updated_at) VALUES ('resume', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [JSON.stringify(parsed.data), Date.now()],
  );

  // Existing verdicts were scored with (or without) the old resume context, so
  // their meaning changed — invalidate, same as a criteria change does.
  if (resumeChangeAffectsVerdicts(prev, parsed.data)) {
    db.run(
      'UPDATE jobs SET l2_verdict_json = NULL, l2_score = NULL, l2_fit = NULL WHERE l2_verdict_json IS NOT NULL',
    );
  }

  return c.json({ ok: true, settings: parsed.data });
});

// Transient PDF → text. Nothing is written to disk or the DB; the client puts
// the result in the editable textarea so extraction artifacts can be fixed
// before saving.
resumeSettings.post('/extract', async c => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) return c.json({ error: 'No file provided' }, 400);
  if (file.type !== 'application/pdf') return c.json({ error: 'Only PDF files are supported' }, 415);
  if (file.size > PDF_MAX_SIZE) return c.json({ error: 'File too large (10MB max)' }, 413);

  try {
    const text = (await extractPdfText(await file.arrayBuffer())).slice(0, RESUME_TEXT_MAX);
    if (!text) return c.json({ error: 'No extractable text found (scanned/image-only PDF?)' }, 422);
    return c.json({ text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Could not read PDF: ${msg}` }, 422);
  }
});
