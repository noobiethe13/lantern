import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client';
import { zodErrorBody } from '../server/errors';

export const boardCacheSettings = new Hono();

// How long a per-company board's last successful fetch is trusted. Within the window a
// scan re-runs L1 over the board's stored jobs instead of fetching it again (boards are
// query-independent, so the stored jobs are exactly what a fetch would return). 0 turns
// the cache off, which fetches every board live on every scan. Stored in the settings KV.
const BoardCacheSettingsSchema = z.object({
  ttlHours: z.number().int().min(0).max(168),
});
type BoardCacheSettings = z.infer<typeof BoardCacheSettingsSchema>;

const DEFAULT_BOARD_CACHE: BoardCacheSettings = { ttlHours: 6 };

export function readBoardCacheSettings(): BoardCacheSettings {
  const row = db
    .query<{ value_json: string }, []>("SELECT value_json FROM settings WHERE key = 'board_cache'")
    .get();
  if (!row) return DEFAULT_BOARD_CACHE;
  const parsed = BoardCacheSettingsSchema.safeParse(JSON.parse(row.value_json));
  return parsed.success ? parsed.data : DEFAULT_BOARD_CACHE;
}

/** Cache window in milliseconds, 0 when the cache is off. Read by the runner. */
export function boardCacheTtlMs(): number {
  return readBoardCacheSettings().ttlHours * 3_600_000;
}

boardCacheSettings.get('/', c => c.json({ settings: readBoardCacheSettings() }));

boardCacheSettings.put('/', async c => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = BoardCacheSettingsSchema.safeParse(body);
  if (!parsed.success) return c.json(zodErrorBody(parsed.error), 400);

  db.run(
    `INSERT INTO settings (key, value_json, updated_at) VALUES ('board_cache', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [JSON.stringify(parsed.data), Date.now()],
  );
  return c.json({ ok: true, settings: parsed.data });
});
