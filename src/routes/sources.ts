import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client';
import { assertValidSlug } from '../core/fetch';
import { zodErrorBody } from '../server/errors';
import { isSeededSource } from '../config/seeds';

export const sources = new Hono();

const SOURCE_TYPES = [
  'greenhouse',
  'ashby',
  'lever',
  'recruitee',
  'smartrecruiters',
  'workable',
  'personio',
  'bamboohr',
  'workday',
  'remoteok',
  'arbeitnow',
  'himalayas',
  'linkedin',
  'google_jobs',
  'jobicy',
] as const;

const SLUG_LABELS: Record<(typeof SOURCE_TYPES)[number], string> = {
  greenhouse: 'Greenhouse board slug',
  ashby: 'Ashby board slug',
  lever: 'Lever board slug',
  recruitee: 'Recruitee tenant slug',
  smartrecruiters: 'SmartRecruiters company slug',
  workable: 'Workable account slug',
  personio: 'Personio tenant slug',
  bamboohr: 'BambooHR subdomain slug',
  workday: 'Workday tenant slug',
  remoteok: 'RemoteOK identifier',
  arbeitnow: 'Arbeitnow identifier',
  himalayas: 'Himalayas identifier',
  linkedin: 'LinkedIn identifier',
  google_jobs: 'Google Jobs identifier',
  jobicy: 'Jobicy identifier',
};

// Keyword-global aggregators have no per-company slug — the role/keyword drives
// the query. They're seeded as singletons; the identifier is just a fixed,
// slug-safe sentinel so the (type, identifier) uniqueness constraint holds.
// LinkedIn is gated/unofficial (default-disabled in the UI) but still a
// keyword-driven aggregator.
export const AGGREGATOR_TYPES: ReadonlySet<string> = new Set([
  'remoteok', 'arbeitnow', 'himalayas', 'linkedin', 'google_jobs', 'jobicy',
]);

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
  // Aggregators ignore the identifier (no per-company slug); any non-empty
  // value is fine. CreateSourceSchema already enforces min length.
  if (AGGREGATOR_TYPES.has(type)) return null;
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

const MASK_PREFIX = '••••';

function maskApiKey(key: string): string {
  return MASK_PREFIX + key.slice(-4);
}

// C6: never echo a stored apiKey back to the client — it's readable via DNS
// rebinding and any log/error surface, and the UI never needs to display it.
function maskConfigJson(configJson: string | null): string | null {
  if (!configJson) return configJson;
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(configJson);
  } catch {
    return configJson;
  }
  if (typeof cfg['apiKey'] === 'string' && cfg['apiKey']) {
    return JSON.stringify({ ...cfg, apiKey: maskApiKey(cfg['apiKey'] as string) });
  }
  return configJson;
}

function maskSourceRow<T extends { config_json?: unknown }>(row: T): T {
  return { ...row, config_json: maskConfigJson((row.config_json as string | null) ?? null) };
}

sources.get('/', c => {
  const rows = db.query<Record<string, unknown>, []>(
    'SELECT * FROM sources ORDER BY type, display_name'
  ).all();
  return c.json({ sources: rows.map(maskSourceRow) });
});

sources.post('/', async c => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = CreateSourceSchema.safeParse(body);
  if (!parsed.success) return c.json(zodErrorBody(parsed.error), 400);

  const { type, identifier, display_name, enabled, config_json } = parsed.data;
  const identifierError = validateIdentifier(type, identifier);
  if (identifierError) return c.json({ error: identifierError }, 400);

  // Workday needs its career-site name (and datacenter/host) in config_json —
  // the single identifier slug can't hold a site name with underscores.
  if (type === 'workday') {
    const site = config_json?.['site'];
    const hasHost = typeof config_json?.['host'] === 'string';
    const hasDc = typeof config_json?.['dc'] === 'string';
    if (typeof site !== 'string' || !site.trim()) {
      return c.json({ error: 'Workday source requires config_json.site (the career-site name)' }, 400);
    }
    if (!hasHost && !hasDc) {
      return c.json({ error: 'Workday source requires config_json.dc (e.g. "wd5") or config_json.host' }, 400);
    }
  }

  // Google Jobs (SerpAPI) needs the user's API key in config_json — never
  // hard-coded. An unconfigured source would be inert, so reject at create time.
  if (type === 'google_jobs') {
    const apiKey = config_json?.['apiKey'];
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      return c.json({ error: 'Google Jobs source requires config_json.apiKey (your SerpAPI key)' }, 400);
    }
  }

  const now = Date.now();
  try {
    const result = db.query<Record<string, unknown>, [string, string, string, number, string | null, number]>(
      `INSERT INTO sources (type, identifier, display_name, enabled, config_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`
    ).get(
      type,
      identifier,
      display_name,
      enabled ? 1 : 0,
      config_json ? JSON.stringify(config_json) : null,
      now
    );
    return c.json({ id: result!['id'], source: maskSourceRow(result!) }, 201);
  } catch (err) {
    if (String(err).includes('UNIQUE')) return c.json({ error: 'Source already exists' }, 409);
    throw err;
  }
});

sources.patch('/:id', async c => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = UpdateSourceSchema.safeParse(body);
  if (!parsed.success) return c.json(zodErrorBody(parsed.error), 400);

  const { display_name, enabled, config_json } = parsed.data;
  const id = Number(c.req.param('id'));

  const existing = db
    .query<{ config_json: string | null }, [number]>('SELECT config_json FROM sources WHERE id = ?')
    .get(id);
  if (!existing) return c.json({ error: 'Source not found' }, 404);

  // C6: a PATCH that round-trips the masked placeholder (e.g. the UI submitting
  // the form unchanged) must not overwrite the real stored key with the mask.
  let finalConfig = config_json;
  if (finalConfig && typeof finalConfig['apiKey'] === 'string' && (finalConfig['apiKey'] as string).startsWith(MASK_PREFIX)) {
    const prevCfg = existing.config_json ? (JSON.parse(existing.config_json) as Record<string, unknown>) : {};
    finalConfig = { ...finalConfig, apiKey: prevCfg['apiKey'] };
  }

  type Binding = string | number | null;
  const sets: string[] = [];
  const params: Binding[] = [];

  if (display_name !== undefined) { sets.push('display_name = ?'); params.push(display_name); }
  if (enabled !== undefined) { sets.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  if (finalConfig !== undefined) { sets.push('config_json = ?'); params.push(JSON.stringify(finalConfig)); }

  if (sets.length > 0) {
    db.run(`UPDATE sources SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  }
  const row = db.query<Record<string, unknown>, [number]>('SELECT * FROM sources WHERE id = ?').get(id);
  return c.json({ ok: true, source: maskSourceRow(row!) });
});

sources.delete('/:id', c => {
  const id = Number(c.req.param('id'));
  const row = db
    .query<{ id: number; type: string; identifier: string }, [number]>(
      'SELECT id, type, identifier FROM sources WHERE id = ?',
    )
    .get(id);
  if (!row) return c.json({ error: 'Source not found' }, 404);

  const jobCount = db
    .query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM jobs WHERE source_id = ?')
    .get(id)?.n ?? 0;

  // jobs.source_id has no ON DELETE and foreign_keys=ON, so deleting a source
  // with saved jobs would throw SQLITE_CONSTRAINT_FOREIGNKEY. A seeded source
  // (present in seed-sources.yml) would also just reappear on the next scan
  // (seedSources() runs INSERT OR IGNORE). Both cases soft-disable instead.
  if (jobCount > 0 || isSeededSource(row.type, row.identifier)) {
    db.run('UPDATE sources SET enabled = 0 WHERE id = ?', [id]);
    const msg = jobCount > 0
      ? `Turned off instead of deleted — it has ${jobCount} saved job${jobCount === 1 ? '' : 's'}`
      : "Turned off instead of deleted — it's a default source and would be re-added on the next scan";
    return c.json({ ok: true, disabled: true, msg });
  }

  db.run('DELETE FROM sources WHERE id = ?', [id]);
  return c.json({ ok: true, deleted: true });
});

