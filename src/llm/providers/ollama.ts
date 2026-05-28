import { z } from 'zod';
import { classifyErrorMessage, LlmError } from '../provider';
import type { HealthcheckResult, LlmProvider, LlmRequest, LlmTask } from '../provider';
import { zodToProviderSchema } from '../zod-to-schema';

export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434';

const STRICT_SUFFIX =
  '\n\nIMPORTANT: Respond with ONLY the JSON object that conforms to the provided schema. No prose, no markdown, no code fences.';

const HEALTH_TIMEOUT_MS = 3_000;

export interface OllamaModelInfo {
  name: string;
  size?: number;
  modified_at?: string;
}

export interface OllamaOptions {
  baseUrl?: string;
}

export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama' as const;
  readonly baseUrl: string;

  constructor(opts: OllamaOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  // Ollama serves user-installed models; there's no provider-managed default.
  // Users pick a model per task in Settings → LLM → Advanced. call() raises a
  // clear error if no override is set.
  defaultModelFor(_task: LlmTask): string {
    return '';
  }

  async call<T>(req: LlmRequest, schema: z.ZodType<T>): Promise<T> {
    const model = req.modelOverride ?? this.defaultModelFor(req.task);
    if (!model) {
      throw new LlmError(
        'fatal',
        `Ollama: no model configured for task '${req.task}'. ` +
        `Pull one (e.g. 'ollama pull llama3.1:8b') and set it under ` +
        `Settings → LLM → Advanced → ${req.task}.`,
      );
    }

    try {
      const raw = await this.generate(model, req.prompt, schema, req.timeoutMs);
      const first = schema.safeParse(raw);
      if (first.success) return first.data;
      console.warn(`[ollama] first-attempt schema error: ${first.error.message}`);
    } catch (err) {
      const msg = (err as Error).message;
      console.warn(`[ollama] first-attempt failed: ${msg}`);
      if (classifyErrorMessage(msg) === 'fatal') {
        throw new LlmError('fatal', `ollama: ${msg}`);
      }
    }

    try {
      const strict = await this.generate(model, req.prompt + STRICT_SUFFIX, schema, req.timeoutMs);
      return schema.parse(strict);
    } catch (err) {
      const msg = (err as Error).message;
      throw new LlmError(classifyErrorMessage(msg), `ollama: ${msg}`);
    }
  }

  async healthcheck(): Promise<HealthcheckResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/api/version`, { signal: ctrl.signal });
      if (!res.ok) {
        return { ok: false, detail: `Ollama /api/version returned ${res.status}` };
      }
      const json = (await res.json()) as { version?: string };
      return { ok: true, detail: `${this.baseUrl} (ollama ${json.version ?? '?'})` };
    } catch (err) {
      return {
        ok: false,
        detail: `Ollama not reachable at ${this.baseUrl} — install from https://ollama.com and run 'ollama serve' (${(err as Error).message})`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async listModels(): Promise<OllamaModelInfo[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama /api/tags returned ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { models?: OllamaModelInfo[] };
    return json.models ?? [];
  }

  private async generate<T>(
    model: string,
    prompt: string,
    schema: z.ZodType<T>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? 120_000);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Ollama's `format` accepts a JSON Schema object directly. `stream: false`
        // gives a single response body instead of NDJSON chunks.
        body: JSON.stringify({
          model,
          prompt,
          format: zodToProviderSchema(schema),
          stream: false,
        }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama /api/generate returned ${res.status}: ${text.slice(0, 200)}`);
    }

    const wrapper = (await res.json()) as { response?: string; error?: string };
    if (wrapper.error) throw new Error(`Ollama error: ${wrapper.error}`);

    const responseText = (wrapper.response ?? '').trim();
    try {
      return JSON.parse(responseText);
    } catch (err) {
      const preview = responseText.slice(0, 200).replace(/\s+/g, ' ');
      throw new Error(
        `Ollama response was not parseable JSON (preview: "${preview}"): ${(err as Error).message}`,
      );
    }
  }
}
