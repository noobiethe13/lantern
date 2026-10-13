import { test, expect, beforeEach, afterAll } from 'bun:test';
import { req, memDb, insertSource, insertJob, resetDb, WORK } from '../test-harness';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

beforeEach(() => {
  resetDb();
});

// isSeededSource() reads src/config/seed-sources.yml relative to process.cwd()
// (chdir'd to WORK by the harness). Seed it once with a fixture entry so the
// "seeded source" delete-path test has something to match against. This file
// is SHARED across the whole suite (one process-wide WORK dir — see
// ../test-harness.ts), and scan.ts's seedSources() re-reads it on every scan,
// so it must be restored to the harness's default afterward or a later file's
// scan test would auto-seed this fixture as a real enabled source and issue a
// real HTTP fetch.
const SEED_SOURCES_PATH = join(WORK, 'src/config/seed-sources.yml');
mkdirSync(join(WORK, 'src/config'), { recursive: true });
writeFileSync(
  SEED_SOURCES_PATH,
  'sources:\n  - { type: greenhouse, identifier: seeded-co, display_name: "Seeded Co", enabled: true }\n',
);

afterAll(() => {
  writeFileSync(SEED_SOURCES_PATH, 'sources: []\n');
});

test('POST /api/sources with an invalid body returns a readable C3 error body', async () => {
  const res = await req('/api/sources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'greenhouse', identifier: 'acme', display_name: '' }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(typeof body.error).toBe('string');
  expect(body.error).not.toContain('[object');
});

test('GET /api/sources masks a stored SerpAPI apiKey', async () => {
  const id = insertSource({
    type: 'google_jobs',
    identifier: 'google_jobs',
    config_json: JSON.stringify({ apiKey: 'sk-live-supersecret1234' }),
  });
  const res = await req('/api/sources');
  const body = await res.json();
  const row = body.sources.find((s: any) => s.id === id);
  const cfg = JSON.parse(row.config_json);
  expect(cfg.apiKey).toBe('••••1234');
  expect(cfg.apiKey).not.toContain('supersecret');
});

test('POST /api/sources response masks the apiKey it just echoed back', async () => {
  const res = await req('/api/sources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'google_jobs',
      identifier: 'google_jobs_2',
      display_name: 'Google Jobs',
      config_json: { apiKey: 'sk-live-anothersecret5678' },
    }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  const cfg = JSON.parse(body.source.config_json);
  expect(cfg.apiKey).toBe('••••5678');
});

test('PATCH with the masked placeholder keeps the real stored key; a real new key overwrites it', async () => {
  const id = insertSource({
    type: 'google_jobs',
    identifier: 'google_jobs_3',
    config_json: JSON.stringify({ apiKey: 'sk-live-original0000' }),
  });

  const noop = await req(`/api/sources/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config_json: { apiKey: '••••0000' } }),
  });
  expect(noop.status).toBe(200);
  const stored1 = memDb.query<{ config_json: string }, [number]>('SELECT config_json FROM sources WHERE id = ?').get(id)!;
  expect(JSON.parse(stored1.config_json).apiKey).toBe('sk-live-original0000');

  const changed = await req(`/api/sources/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config_json: { apiKey: 'sk-live-brandnew1111' } }),
  });
  expect(changed.status).toBe(200);
  const stored2 = memDb.query<{ config_json: string }, [number]>('SELECT config_json FROM sources WHERE id = ?').get(id)!;
  expect(JSON.parse(stored2.config_json).apiKey).toBe('sk-live-brandnew1111');
  const changedBody = await changed.json();
  expect(JSON.parse(changedBody.source.config_json).apiKey).toBe('••••1111');
});

test('DELETE on a user-added source with no jobs hard-deletes it', async () => {
  const id = insertSource({ type: 'greenhouse', identifier: 'user-added-co' });
  const res = await req(`/api/sources/${id}`, { method: 'DELETE' });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ ok: true, deleted: true });
  expect(memDb.query('SELECT id FROM sources WHERE id = ?').get(id)).toBeNull();
});

test('DELETE on a source with saved jobs soft-disables instead of throwing a FK violation', async () => {
  const id = insertSource({ type: 'greenhouse', identifier: 'has-jobs-co' });
  insertJob(id);
  insertJob(id);
  const res = await req(`/api/sources/${id}`, { method: 'DELETE' });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.disabled).toBe(true);
  expect(body.msg).toContain('2 saved jobs');
  const row = memDb.query<{ enabled: number }, [number]>('SELECT enabled FROM sources WHERE id = ?').get(id)!;
  expect(row.enabled).toBe(0);
});

test('DELETE on a seeded source with no jobs soft-disables (would otherwise reappear on next scan)', async () => {
  const id = insertSource({ type: 'greenhouse', identifier: 'seeded-co' });
  const res = await req(`/api/sources/${id}`, { method: 'DELETE' });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ ok: true, disabled: true, msg: expect.any(String) });
  expect(memDb.query('SELECT id FROM sources WHERE id = ?').get(id)).not.toBeNull();
});

test('DELETE on a missing source returns 404', async () => {
  const res = await req('/api/sources/999999', { method: 'DELETE' });
  expect(res.status).toBe(404);
  const body = await res.json();
  expect(typeof body.error).toBe('string');
});

const putDiscovered = (body: unknown) =>
  req('/api/sources/discovered', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const enabledOf = (id: number) =>
  memDb.query<{ enabled: number }, [number]>('SELECT enabled FROM sources WHERE id = ?').get(id)!.enabled;

test('GET /api/sources leaves discovered boards out of the roster', async () => {
  const mine = insertSource({ type: 'greenhouse', identifier: 'mine-co' });
  insertSource({ type: 'ashby', identifier: 'found-co', origin: 'discovered' });
  const body = await (await req('/api/sources')).json();
  expect(body.sources.map((s: any) => s.id)).toEqual([mine]);
});

test('GET /api/sources/discovered counts discovered boards and how many are enabled', async () => {
  insertSource({ type: 'ashby', identifier: 'd1', origin: 'discovered', enabled: 1 });
  insertSource({ type: 'ashby', identifier: 'd2', origin: 'discovered' });
  insertSource({ type: 'greenhouse', identifier: 'not-discovered', enabled: 1 });
  expect(await (await req('/api/sources/discovered')).json()).toEqual({ total: 2, enabled: 1 });
});

test('GET /api/sources/discovered is zeroed when there are none', async () => {
  expect(await (await req('/api/sources/discovered')).json()).toEqual({ total: 0, enabled: 0 });
});

test('PUT /api/sources/discovered bulk-toggles only discovered boards', async () => {
  const d1 = insertSource({ type: 'ashby', identifier: 'd1', origin: 'discovered' });
  const d2 = insertSource({ type: 'lever', identifier: 'd2', origin: 'discovered' });
  const mine = insertSource({ type: 'greenhouse', identifier: 'mine-co' });

  const on = await putDiscovered({ enabled: true });
  expect(on.status).toBe(200);
  expect(await on.json()).toEqual({ ok: true, total: 2, enabled: 2 });
  expect([enabledOf(d1), enabledOf(d2), enabledOf(mine)]).toEqual([1, 1, 0]);

  const off = await putDiscovered({ enabled: false });
  expect(await off.json()).toEqual({ ok: true, total: 2, enabled: 0 });
  expect([enabledOf(d1), enabledOf(d2)]).toEqual([0, 0]);
});

test('PUT /api/sources/discovered rejects a body without a boolean', async () => {
  expect((await putDiscovered({ enabled: 'yes' })).status).toBe(400);
});

test('DELETE on a discovered board soft-disables (it would be re-seeded)', async () => {
  const id = insertSource({ type: 'ashby', identifier: 'found-co', origin: 'discovered', enabled: 1 });
  const body = await (await req(`/api/sources/${id}`, { method: 'DELETE' })).json();
  expect(body.disabled).toBe(true);
  expect(enabledOf(id)).toBe(0);
});

test('POST of a board discovery already holds adopts the hidden row instead of conflicting', async () => {
  const id = insertSource({ type: 'ashby', identifier: 'found-co', origin: 'discovered' });
  const post = () =>
    req('/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ashby', identifier: 'found-co', display_name: 'Found Co' }),
    });

  const res = await post();
  expect(res.status).toBe(201);
  expect((await res.json()).id).toBe(id);
  const row = memDb
    .query<{ origin: string | null; enabled: number }, [number]>('SELECT origin, enabled FROM sources WHERE id = ?')
    .get(id)!;
  expect(row).toEqual({ origin: null, enabled: 1 });

  expect((await post()).status).toBe(409);
});

test('POST adopts a discovered board even when the slug differs only in case', async () => {
  const id = insertSource({ type: 'ashby', identifier: 'Found-Co', origin: 'discovered' });
  const res = await req('/api/sources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'ashby', identifier: 'found-co', display_name: 'Found Co' }),
  });
  expect(res.status).toBe(201);
  expect((await res.json()).id).toBe(id);
  expect(memDb.query('SELECT COUNT(*) AS n FROM sources').get()).toEqual({ n: 1 });
});

test('the discovered switch works before any scan: GET and PUT seed from the file on demand', async () => {
  const path = join(WORK, 'src/config/discovered-sources.json');
  writeFileSync(
    path,
    JSON.stringify({
      generated: {},
      sources: [
        { type: 'ashby', identifier: 'a1', display_name: 'A1' },
        { type: 'lever', identifier: 'l1', display_name: 'L1' },
      ],
    }),
  );
  try {
    expect(await (await req('/api/sources/discovered')).json()).toEqual({ total: 2, enabled: 0 });
    const on = await (await putDiscovered({ enabled: true })).json();
    expect(on).toEqual({ ok: true, total: 2, enabled: 2 });
  } finally {
    rmSync(path);
  }
});

test('POST with two discovered case variants adopts exactly one and leaves the other disabled', async () => {
  const upper = insertSource({ type: 'ashby', identifier: 'Found-Co', origin: 'discovered' });
  const lower = insertSource({ type: 'ashby', identifier: 'found-co', origin: 'discovered' });
  const res = await req('/api/sources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'ashby', identifier: 'found-co', display_name: 'Found Co' }),
  });
  expect(res.status).toBe(201);
  expect((await res.json()).id).toBe(lower); // exact spelling wins
  const rows = memDb.query<{ id: number; origin: string | null; enabled: number }, []>(
    'SELECT id, origin, enabled FROM sources ORDER BY id',
  ).all();
  expect(rows).toEqual([
    { id: upper, origin: 'discovered', enabled: 0 },
    { id: lower, origin: null, enabled: 1 },
  ]);
});
