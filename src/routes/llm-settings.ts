import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client';
import { llm, resetLlmCache } from '../llm';
import type { ProviderName } from '../llm/provider';
import { OLLAMA_DEFAULT_BASE_URL, OllamaProvider } from '../llm/providers/ollama';

export const llmSettings = new Hono();

const TASKS = ['verdict', 'nl-filter', 'html-extract', 'hn-extract'] as const;
const PROVIDERS = ['gemini-api', 'anthropic-api', 'claude-code', 'antigravity-cli', 'ollama'] as const;

const LlmSettingsSchema = z.object({
  provider: z.enum(PROVIDERS),
  gemini_api_key: z.string().optional(),
  anthropic_api_key: z.string().optional(),
  ollama_base_url: z.string().url().optional(),
  per_task_overrides: z.record(z.enum(TASKS), z.string().min(1).max(120)).optional(),
});

type LlmSettingsBody = z.infer<typeof LlmSettingsSchema>;

const DEFAULT: LlmSettingsBody = { provider: 'gemini-api' };

function readSettings(): LlmSettingsBody {
  const row = db
    .query<{ value_json: string }, []>("SELECT value_json FROM settings WHERE key = 'llm'")
    .get();
  if (!row) return DEFAULT;
  const parsed = LlmSettingsSchema.safeParse(JSON.parse(row.value_json));
  return parsed.success ? parsed.data : DEFAULT;
}

// Providers that ship but don't have a working backend yet (currently:
// antigravity-cli, which is a stub until Google publishes a headless contract
// for the `agy` binary). Surfaced to the UI so it can render a non-blocking
// "unsupported" badge instead of letting users select a provider that errors
// out on the first call.
const UNSUPPORTED_PROVIDERS: Partial<Record<ProviderName, string>> = {
  'antigravity-cli': "No documented headless JSON mode yet. Switch to another provider.",
};

llmSettings.get('/', c => {
  return c.json({
    settings: readSettings(),
    available_providers: PROVIDERS,
    tasks: TASKS,
    deprecations: {} as Record<ProviderName, string>,
    unsupported: UNSUPPORTED_PROVIDERS,
  });
});

llmSettings.put('/', async c => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = LlmSettingsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

  const now = Date.now();
  db.run(
    `INSERT INTO settings (key, value_json, updated_at) VALUES ('llm', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [JSON.stringify(parsed.data), now],
  );
  // Provider instance is cached against the previous settings; drop it so the
  // next llm.call() picks up the new provider / baseUrl / overrides.
  resetLlmCache();
  return c.json({ ok: true, settings: parsed.data });
});

llmSettings.get('/health', async c => {
  try {
    const result = await llm.healthcheck();
    return c.json({ provider: llm.providerName, ...result }, result.ok ? 200 : 503);
  } catch (err) {
    return c.json(
      { provider: llm.providerName, ok: false, detail: String(err) },
      503,
    );
  }
});

// Lists models installed on a given Ollama instance. baseUrl is taken from the
// optional query string so the UI can preview models against a not-yet-saved
// URL; falls back to the saved setting, then the package default.
llmSettings.get('/ollama-models', async c => {
  const queryUrl = c.req.query('baseUrl');
  const baseUrl = queryUrl?.trim() || readSettings().ollama_base_url || OLLAMA_DEFAULT_BASE_URL;

  try {
    const probe = new OllamaProvider({ baseUrl });
    const models = await probe.listModels();
    return c.json({ baseUrl: probe.baseUrl, models });
  } catch (err) {
    return c.json({ baseUrl, models: [], error: String(err) }, 503);
  }
});
