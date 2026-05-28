import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';
import type { HealthcheckResult, LlmProvider, LlmRequest, LlmTask } from '../provider';
import { zodToProviderSchema } from '../zod-to-schema';

const TASK_MODELS: Record<LlmTask, string> = {
  verdict: 'gemini-2.5-pro',
  'nl-filter': 'gemini-2.5-flash',
  'html-extract': 'gemini-2.5-pro',
  'hn-extract': 'gemini-2.5-flash',
};

const STRICT_SUFFIX =
  '\n\nIMPORTANT: Respond with ONLY a JSON object matching the schema. No prose, no markdown.';

export class GeminiApiProvider implements LlmProvider {
  readonly name = 'gemini-api' as const;

  constructor(private readonly apiKey: string) {}

  defaultModelFor(task: LlmTask): string {
    return TASK_MODELS[task];
  }

  async call<T>(req: LlmRequest, schema: z.ZodType<T>): Promise<T> {
    const modelName = req.modelOverride ?? this.defaultModelFor(req.task);
    const client = new GoogleGenerativeAI(this.apiKey);
    const model = client.getGenerativeModel({
      model: modelName,
      generationConfig: {
        temperature: 0.4,
        responseMimeType: 'application/json',
        responseSchema: zodToProviderSchema(schema) as never,
      },
    });

    try {
      const result = await model.generateContent(req.prompt);
      const parsed = JSON.parse(result.response.text());
      const first = schema.safeParse(parsed);
      if (first.success) return first.data;
      console.warn(`[gemini-api] first-attempt schema error: ${first.error.message}`);
    } catch (err) {
      console.warn(`[gemini-api] first-attempt failed: ${(err as Error).message}`);
    }

    const strict = await model.generateContent(req.prompt + STRICT_SUFFIX);
    return schema.parse(JSON.parse(strict.response.text()));
  }

  async healthcheck(): Promise<HealthcheckResult> {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${this.apiKey}`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (res.ok) return { ok: true, detail: 'gemini-api: API key accepted' };
      const body = await res.text().catch(() => '');
      return { ok: false, detail: `gemini-api: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 120)}` : ''}` };
    } catch (err) {
      return { ok: false, detail: `gemini-api: ${(err as Error).message}` };
    }
  }
}
