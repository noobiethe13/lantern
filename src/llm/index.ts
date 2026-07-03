import { z } from 'zod';
import { db } from '../db/client';
import type { HealthcheckResult, LlmRequest, ProviderName } from './provider';
import { LLM_TASKS } from './provider';
import { ClaudeCodeProvider } from './providers/claude-code';

// Since the Phase 8 strip-down, claude-code is the only provider. The `llm`
// settings KV row now carries nothing but optional per-task model overrides,
// which are re-read on every call() (never cached against a provider instance).
const LlmSettingsShape = z.object({
  per_task_overrides: z.record(z.enum(LLM_TASKS), z.string().min(1)).optional(),
});

type LlmSettings = z.infer<typeof LlmSettingsShape>;

const DEFAULT_SETTINGS: LlmSettings = {};

function loadSettings(): LlmSettings {
  let row: { value_json: string } | null = null;
  try {
    row = db
      .query<{ value_json: string }, []>("SELECT value_json FROM settings WHERE key = 'llm'")
      .get();
  } catch (err) {
    console.warn(`[llm] settings table read failed, using defaults: ${(err as Error).message}`);
    return DEFAULT_SETTINGS;
  }
  if (!row) return DEFAULT_SETTINGS;

  let json: unknown;
  try {
    json = JSON.parse(row.value_json);
  } catch (err) {
    console.warn(
      `[llm] settings JSON parse failed, using defaults — value: "${row.value_json.slice(0, 100)}" — ${(err as Error).message}`,
    );
    return DEFAULT_SETTINGS;
  }

  const parsed = LlmSettingsShape.safeParse(json);
  if (!parsed.success) {
    console.warn(`[llm] settings shape mismatch, using defaults: ${parsed.error.message}`);
    return DEFAULT_SETTINGS;
  }
  return parsed.data;
}

// The provider takes no construction inputs, so a single lazily-built instance
// lives for the process. resetLlmCache() is retained for the settings route to
// call after a write, but with a stateless provider it's effectively a no-op.
let provider: ClaudeCodeProvider | null = null;

function getProvider(): ClaudeCodeProvider {
  if (!provider) provider = new ClaudeCodeProvider();
  return provider;
}

export function resetLlmCache(): void {
  provider = null;
}

export const llm = {
  async call<T>(req: LlmRequest, schema: z.ZodType<T>): Promise<T> {
    const settings = loadSettings();
    const override = settings.per_task_overrides?.[req.task];
    const effective: LlmRequest = override && !req.modelOverride
      ? { ...req, modelOverride: override }
      : req;
    return getProvider().call(effective, schema);
  },

  async healthcheck(): Promise<HealthcheckResult> {
    return getProvider().healthcheck();
  },

  get providerName(): ProviderName {
    return getProvider().name;
  },
};
