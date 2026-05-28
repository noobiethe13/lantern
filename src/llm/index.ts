import { z } from 'zod';
import { db } from '../db/client';
import type { HealthcheckResult, LlmProvider, LlmRequest, ProviderName } from './provider';
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
  per_task_overrides: z.record(z.string()).optional(),
});

type LlmSettings = z.infer<typeof LlmSettingsShape>;

const DEFAULT_SETTINGS: LlmSettings = { provider: 'gemini-api' };

function loadSettings(): LlmSettings {
  try {
    const row = db
      .query<{ value_json: string }, []>("SELECT value_json FROM settings WHERE key = 'llm'")
      .get();
    if (!row) return DEFAULT_SETTINGS;
    const parsed = LlmSettingsShape.safeParse(JSON.parse(row.value_json));
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
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
