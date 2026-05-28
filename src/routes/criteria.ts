import { Hono } from 'hono';
import { z } from 'zod';
import yaml from 'js-yaml';
import { db } from '../db/client';
import { llm } from '../llm';
import { NLFilterShape } from '../llm/schemas';
import { nlFilterPrompt } from '../llm/prompts';

export const criteria = new Hono();

criteria.get('/', c => {
  const row = db
    .query<{ yaml: string; source_text: string | null; updated_at: number }, []>(
      'SELECT yaml, source_text, updated_at FROM criteria WHERE id = 1'
    )
    .get();
  if (!row) return c.json({ yaml: '', source_text: null, updated_at: null });
  return c.json(row);
});

criteria.put('/', async c => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ yaml: z.string().min(1).max(32000) }).safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

  try {
    yaml.load(parsed.data.yaml);
  } catch {
    return c.json({ error: 'Invalid YAML' }, 400);
  }

  const now = Date.now();
  db.run(
    `INSERT INTO criteria (id, yaml, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET yaml = excluded.yaml, updated_at = excluded.updated_at`,
    [parsed.data.yaml, now]
  );
  // Criteria change invalidates every prior L2 verdict — those were scored
  // against the old rubric. Next scan re-runs L2 over the survivors.
  const { changes: invalidated } = db.run(
    'UPDATE jobs SET l2_verdict_json = NULL WHERE l2_verdict_json IS NOT NULL'
  );
  return c.json({ ok: true, invalidated });
});

criteria.post('/from-nl', async c => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ text: z.string().min(1).max(2000) }).safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

  const prompt = nlFilterPrompt(parsed.data.text);
  const result = await llm.call({ task: 'nl-filter', prompt }, NLFilterShape);

  const yamlStr = yaml.dump(result, { lineWidth: 120 });
  const now = Date.now();
  db.run(
    `INSERT INTO criteria (id, yaml, source_text, updated_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET yaml = excluded.yaml, source_text = excluded.source_text, updated_at = excluded.updated_at`,
    [yamlStr, parsed.data.text, now]
  );
  // See PUT / — same invalidation logic on the NL path.
  const { changes: invalidated } = db.run(
    'UPDATE jobs SET l2_verdict_json = NULL WHERE l2_verdict_json IS NOT NULL'
  );

  return c.json({ yaml: yamlStr, parsed: result, invalidated });
});
