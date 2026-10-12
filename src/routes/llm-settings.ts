import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client';
import { llm, resetLlmCache } from '../llm';
import { LLM_TASKS, MODEL_OVERRIDE_RE } from '../llm/provider';

export const llmSettings = new Hono();

// Since the Phase 8 strip-down, claude-code is the only provider. The settings
// surface carries nothing but optional per-task model overrides. The override
// is later spliced into the CLI argv right after `--model` (claude-code.ts), so
// it's validated against MODEL_OVERRIDE_RE rather than a bare length check — an
// unvalidated string could otherwise be re-parsed by the CLI as a flag (e.g.
// "--dangerously-skip-permissions").
const LlmSettingsSchema = z.object({
  per_task_overrides: z
    .record(z.enum(LLM_TASKS), z.string().regex(MODEL_OVERRIDE_RE, 'not a valid model id'))
    .optional(),
});

type LlmSettingsBody = z.infer<typeof LlmSettingsSchema>;

const DEFAULT: LlmSettingsBody = {};

function readSettings(): LlmSettingsBody {
  const row = db
    .query<{ value_json: string }, []>("SELECT value_json FROM settings WHERE key = 'llm'")
    .get();
  if (!row) return DEFAULT;
  const parsed = LlmSettingsSchema.safeParse(JSON.parse(row.value_json));
  return parsed.success ? parsed.data : DEFAULT;
}

llmSettings.get('/', c => {
  return c.json({
    settings: readSettings(),
    provider: llm.providerName,
    tasks: LLM_TASKS,
  });
});

llmSettings.put('/', async c => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = LlmSettingsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid settings', issues: parsed.error.issues }, 400);

  const now = Date.now();
  db.run(
    `INSERT INTO settings (key, value_json, updated_at) VALUES ('llm', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [JSON.stringify(parsed.data), now],
  );
  // Settings are re-read on every llm.call(); resetLlmCache keeps the contract
  // symmetric with how the provider used to be cached against its inputs.
  resetLlmCache();
  return c.json({ ok: true, settings: parsed.data });
});
