import { Hono } from 'hono';
import { db } from '../db/client';
import {
  DEFAULT_EMBEDDING_SETTINGS,
  EmbeddingSettingsSchema,
  type EmbeddingSettings,
} from '../core/embed';
import { zodErrorBody } from '../server/errors';

export const embeddingSettings = new Hono();

// Local semantic-ranking toggle. Stored in the settings KV. Default ON; when off
// the runner never loads the embedding model (no download). Unlike resume/criteria
// changes, flipping this does NOT invalidate verdicts — embeddings reorder the L2
// queue and let semantic rescue add jobs to it, but never change a verdict's content.

export function readEmbeddingSettings(): EmbeddingSettings {
  const row = db
    .query<{ value_json: string }, []>("SELECT value_json FROM settings WHERE key = 'embeddings'")
    .get();
  if (!row) return DEFAULT_EMBEDDING_SETTINGS;
  const parsed = EmbeddingSettingsSchema.safeParse(JSON.parse(row.value_json));
  return parsed.success ? parsed.data : DEFAULT_EMBEDDING_SETTINGS;
}

/** Whether the local semantic pre-ranker should run. Read by the runner. */
export function embeddingEnabled(): boolean {
  return readEmbeddingSettings().enabled;
}

embeddingSettings.get('/', (c) => {
  return c.json({ settings: readEmbeddingSettings() });
});

embeddingSettings.put('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = EmbeddingSettingsSchema.safeParse(body);
  if (!parsed.success) return c.json(zodErrorBody(parsed.error), 400);

  db.run(
    `INSERT INTO settings (key, value_json, updated_at) VALUES ('embeddings', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [JSON.stringify(parsed.data), Date.now()],
  );
  return c.json({ ok: true, settings: parsed.data });
});
