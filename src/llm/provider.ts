import type { z } from 'zod';

export type LlmTask =
  | 'verdict'      // L2 fit scoring with criteria + JD
  | 'nl-filter'    // user natural-language → structured filter
  | 'html-extract' // arbitrary HTML → jobs[]
  | 'hn-extract';  // HN "Who's Hiring" comment → jobs[]

export type ProviderName = 'gemini-api' | 'claude-code' | 'antigravity-cli' | 'ollama';

export interface LlmRequest {
  task: LlmTask;
  prompt: string;
  timeoutMs?: number;
  modelOverride?: string;
}

export interface HealthcheckResult {
  ok: boolean;
  detail: string;
  deprecation?: string;
}

export interface LlmProvider {
  name: ProviderName;
  call<T>(req: LlmRequest, schema: z.ZodType<T>): Promise<T>;
  healthcheck(): Promise<HealthcheckResult>;
  defaultModelFor(task: LlmTask): string;
}
