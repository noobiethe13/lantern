import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client';
import { zodErrorBody } from '../server/errors';

export const l2CapSettings = new Hono();

// Per-search cap on how many L1 survivors L2 grades. L2 is the binding cost (one
// batch of 20 is one `claude` call), so an unbounded pass over thousands of
// survivors can run for hours. Survivors beyond the cap keep NULL verdicts, so an
// identical re-search picks up where this one stopped. Stored in the settings KV.
const L2CapSettingsSchema = z.object({
  maxJobs: z.number().int().min(20).max(5000),
});
type L2CapSettings = z.infer<typeof L2CapSettingsSchema>;

const DEFAULT_L2_CAP: L2CapSettings = { maxJobs: 300 };

export function readL2CapSettings(): L2CapSettings {
  const row = db
    .query<{ value_json: string }, []>("SELECT value_json FROM settings WHERE key = 'l2_cap'")
    .get();
  if (!row) return DEFAULT_L2_CAP;
  const parsed = L2CapSettingsSchema.safeParse(JSON.parse(row.value_json));
  return parsed.success ? parsed.data : DEFAULT_L2_CAP;
}

/** Max survivors L2 grades in one run. Read by the runner. */
export function l2MaxJobs(): number {
  return readL2CapSettings().maxJobs;
}

l2CapSettings.get('/', c => c.json({ settings: readL2CapSettings() }));

l2CapSettings.put('/', async c => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = L2CapSettingsSchema.safeParse(body);
  if (!parsed.success) return c.json(zodErrorBody(parsed.error), 400);

  db.run(
    `INSERT INTO settings (key, value_json, updated_at) VALUES ('l2_cap', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [JSON.stringify(parsed.data), Date.now()],
  );
  return c.json({ ok: true, settings: parsed.data });
});
