import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client';
import { assertValidSlug } from '../core/fetch';

export const sources = new Hono();

const SOURCE_TYPES = [
  'greenhouse',
  'ashby',
  'lever',
  'recruitee',
  'smartrecruiters',
  'workable',
  'personio',
] as const;

const SLUG_LABELS: Record<(typeof SOURCE_TYPES)[number], string> = {
  greenhouse: 'Greenhouse board slug',
  ashby: 'Ashby board slug',
  lever: 'Lever board slug',
  recruitee: 'Recruitee tenant slug',
  smartrecruiters: 'SmartRecruiters company slug',
  workable: 'Workable account slug',
  personio: 'Personio tenant slug',
};

const CreateSourceSchema = z.object({
  type: z.enum(SOURCE_TYPES),
  identifier: z.string().min(1).max(500),
  display_name: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
  config_json: z.record(z.unknown()).optional(),
});

// Validate the user-supplied identifier per source type. Every supported board
// keys off a URL-path-safe tenant/board slug.
function validateIdentifier(type: (typeof SOURCE_TYPES)[number], identifier: string): string | null {
  try {
    assertValidSlug(identifier, SLUG_LABELS[type]);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const UpdateSourceSchema = z.object({
  display_name: z.string().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  config_json: z.record(z.unknown()).optional(),
});

sources.get('/', c => {
  const rows = db.query<Record<string, unknown>, []>(
    'SELECT * FROM sources ORDER BY type, display_name'
  ).all();
  return c.json({ sources: rows });
});

sources.post('/', async c => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = CreateSourceSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

  const { type, identifier, display_name, enabled, config_json } = parsed.data;
  const identifierError = validateIdentifier(type, identifier);
  if (identifierError) return c.json({ error: identifierError }, 400);

  const now = Date.now();
  try {
    const result = db.query<{ id: number }, [string, string, string, number, string | null, number]>(
      `INSERT INTO sources (type, identifier, display_name, enabled, config_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
    ).get(
      type,
      identifier,
      display_name,
      enabled ? 1 : 0,
      config_json ? JSON.stringify(config_json) : null,
      now
    );
    return c.json({ id: result!.id }, 201);
  } catch (err) {
    if (String(err).includes('UNIQUE')) return c.json({ error: 'Source already exists' }, 409);
    throw err;
  }
});

sources.patch('/:id', async c => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = UpdateSourceSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

  const { display_name, enabled, config_json } = parsed.data;
  const id = Number(c.req.param('id'));

  type Binding = string | number | null;
  const sets: string[] = [];
  const params: Binding[] = [];

  if (display_name !== undefined) { sets.push('display_name = ?'); params.push(display_name); }
  if (enabled !== undefined) { sets.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  if (config_json !== undefined) { sets.push('config_json = ?'); params.push(JSON.stringify(config_json)); }

  if (sets.length > 0) {
    db.run(`UPDATE sources SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  }
  return c.json({ ok: true });
});

sources.delete('/:id', c => {
  db.run('DELETE FROM sources WHERE id = ?', [Number(c.req.param('id'))]);
  return c.json({ ok: true });
});

