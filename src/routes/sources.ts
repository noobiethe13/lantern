import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client';
import { fetchGenericUrlPage } from '../sources/generic-url';
import { assertSafeHttpUrl, assertValidSlug } from '../core/fetch';
import { isSourceFetchError, type SourceFetchErrorKind } from '../server/errors';

export const sources = new Hono();

const SOURCE_TYPES = ['greenhouse', 'ashby', 'lever', 'hn-whos-hiring', 'generic-url'] as const;

const CreateSourceSchema = z.object({
  type: z.enum(SOURCE_TYPES),
  identifier: z.string().min(1).max(500),
  display_name: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
  config_json: z.record(z.unknown()).optional(),
});

// Validate the user-supplied identifier per source type. Greenhouse/Ashby/
// Lever expect a board slug; generic-url expects a real URL with the SSRF
// guard applied; hn-whos-hiring has no URL data to validate.
function validateIdentifier(type: typeof SOURCE_TYPES[number], identifier: string): string | null {
  try {
    switch (type) {
      case 'greenhouse':
        assertValidSlug(identifier, 'Greenhouse board slug');
        return null;
      case 'ashby':
        assertValidSlug(identifier, 'Ashby board slug');
        return null;
      case 'lever':
        assertValidSlug(identifier, 'Lever board slug');
        return null;
      case 'generic-url':
        assertSafeHttpUrl(identifier);
        return null;
      case 'hn-whos-hiring':
        return null;
    }
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

interface SourceTestRow {
  id: number;
  type: string;
  identifier: string;
  display_name: string;
}

type TestKind = SourceFetchErrorKind | 'unsupported';

// Probes a generic-url source by fetching the page only — no LLM call. Surfaces
// gated / login-wall / network failures with a structured `kind`.
sources.post('/:id/test', async c => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) {
    return c.json({ ok: false, kind: 'unsupported' as TestKind, detail: 'Invalid source id' }, 400);
  }

  const source = db
    .query<SourceTestRow, [number]>(
      'SELECT id, type, identifier, display_name FROM sources WHERE id = ?'
    )
    .get(id);

  if (!source) {
    return c.json({ ok: false, kind: 'unsupported' as TestKind, detail: 'Source not found' }, 404);
  }

  if (source.type !== 'generic-url') {
    return c.json(
      {
        ok: false,
        kind: 'unsupported' as TestKind,
        detail: `Test is only available for generic-url sources. This source is of type "${source.type}".`,
      },
      400,
    );
  }

  try {
    const page = await fetchGenericUrlPage(source.identifier);
    return c.json({
      ok: true,
      detail: `Fetched ${page.contentKind} (${page.content.length} chars).`,
      finalUrl: page.finalUrl,
      title: page.title,
      contentKind: page.contentKind,
      snippet: page.content.slice(0, 400),
    });
  } catch (err) {
    if (isSourceFetchError(err)) {
      return c.json({ ok: false, kind: err.kind as TestKind, detail: err.message });
    }
    return c.json({
      ok: false,
      kind: 'http' as TestKind,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

