import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client';
import { zodErrorBody } from '../server/errors';

export const freshnessSettings = new Hono();

// L1 freshness gate. Stored in the settings KV. Default ON at 7 days: dated jobs
// older than the window fail L1 (so they never reach L2 — the binding cost), while
// jobs with no posted date always pass. This is an L1 input, not criteria — it
// changes which jobs are scored, not what a verdict means, so flipping it does NOT
// invalidate stored verdicts (a re-scan re-applies it). Read by the runner.

const FreshnessSettingsSchema = z.object({
  enabled: z.boolean(),
  maxAgeDays: z.number().int().min(1).max(365),
});
type FreshnessSettings = z.infer<typeof FreshnessSettingsSchema>;

const DEFAULT_FRESHNESS: FreshnessSettings = { enabled: true, maxAgeDays: 7 };

export function readFreshnessSettings(): FreshnessSettings {
  const row = db
    .query<{ value_json: string }, []>("SELECT value_json FROM settings WHERE key = 'freshness'")
    .get();
  if (!row) return DEFAULT_FRESHNESS;
  const parsed = FreshnessSettingsSchema.safeParse(JSON.parse(row.value_json));
  return parsed.success ? parsed.data : DEFAULT_FRESHNESS;
}

/** Max posted-age in days for the L1 gate, or 0 when disabled. Read by the runner. */
export function freshnessMaxAgeDays(): number {
  const s = readFreshnessSettings();
  return s.enabled ? s.maxAgeDays : 0;
}

freshnessSettings.get('/', (c) => {
  return c.json({ settings: readFreshnessSettings() });
});

freshnessSettings.put('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = FreshnessSettingsSchema.safeParse(body);
  if (!parsed.success) return c.json(zodErrorBody(parsed.error), 400);

  db.run(
    `INSERT INTO settings (key, value_json, updated_at) VALUES ('freshness', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [JSON.stringify(parsed.data), Date.now()],
  );
  return c.json({ ok: true, settings: parsed.data });
});
