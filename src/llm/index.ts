import { z } from 'zod';
import { db } from '../db/client';
import type { HealthcheckResult, LlmProvider, LlmRequest, ProviderName } from './provider';
import { LLM_TASKS } from './provider';
import { AnthropicApiProvider } from './providers/anthropic-api';
import { AntigravityCliProvider } from './providers/antigravity-cli';
import { ClaudeCodeProvider } from './providers/claude-code';
import { GeminiApiProvider } from './providers/gemini-api';
import { OllamaProvider } from './providers/ollama';

const LlmSettingsShape = z.object({
  provider: z.enum(['gemini-api', 'anthropic-api', 'claude-code', 'antigravity-cli', 'ollama']),
  gemini_api_key: z.string().optional(),
  anthropic_api_key: z.string().optional(),
  ollama_base_url: z.string().url().optional(),
  per_task_overrides: z.record(z.enum(LLM_TASKS), z.string().min(1)).optional(),
});

type LlmSettings = z.infer<typeof LlmSettingsShape>;

const DEFAULT_SETTINGS: LlmSettings = { provider: 'gemini-api' };

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

function createProvider(settings: LlmSettings): LlmProvider {
  switch (settings.provider) {
    case 'gemini-api':
      return new GeminiApiProvider(settings.gemini_api_key ?? '');
    case 'anthropic-api':
      return new AnthropicApiProvider(settings.anthropic_api_key ?? '');
    case 'claude-code':
      return new ClaudeCodeProvider();
    case 'ollama':
      return new OllamaProvider({ baseUrl: settings.ollama_base_url });
    case 'antigravity-cli':
      return new AntigravityCliProvider();
  }
}

// Cache invalidates whenever any provider-construction input changes (the
// provider name itself, API keys, or the Ollama baseUrl). per_task_overrides
// do NOT trigger reconstruction — they're re-read on every call().
function constructionKey(s: LlmSettings): string {
  return `${s.provider}|${s.gemini_api_key ?? ''}|${s.anthropic_api_key ?? ''}|${s.ollama_base_url ?? ''}`;
}

let cached: { provider: LlmProvider; settings: LlmSettings; key: string } | null = null;

function getCached(): { provider: LlmProvider; settings: LlmSettings } {
  const settings = loadSettings();
  const key = constructionKey(settings);
  if (!cached || cached.key !== key) {
    cached = { provider: createProvider(settings), settings, key };
  } else {
    cached.settings = settings;
  }
  return cached;
}

export function resetLlmCache(): void {
  cached = null;
}

export const llm = {
  async call<T>(req: LlmRequest, schema: z.ZodType<T>): Promise<T> {
    const { provider, settings } = getCached();
    const override = settings.per_task_overrides?.[req.task];
    const effective: LlmRequest = override && !req.modelOverride
      ? { ...req, modelOverride: override }
      : req;
    return provider.call(effective, schema);
  },

  async healthcheck(): Promise<HealthcheckResult> {
    return getCached().provider.healthcheck();
  },

  get providerName(): ProviderName {
    return getCached().provider.name;
  },
};
