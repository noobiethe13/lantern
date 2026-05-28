import type { z } from 'zod';

// Single source of truth for the LLM task list. Used by:
//   - LlmTask union type (below)
//   - routes/llm-settings.ts schema (z.enum on TASKS)
//   - core/llm/index.ts settings shape (per_task_overrides validation)
export const LLM_TASKS = ['verdict', 'nl-filter', 'html-extract', 'hn-extract'] as const;
export type LlmTask = (typeof LLM_TASKS)[number];

export type ProviderName =
  | 'gemini-api'
  | 'anthropic-api'
  | 'claude-code'
  | 'antigravity-cli'
  | 'ollama';

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

// Providers throw LlmError when they can classify the failure mode. `fatal`
// failures (missing CLI, invalid API key, banned model) won't improve by
// retrying the next job, so the runner aborts immediately. `transient` failures
// (timeouts, 5xx, single bad model output) count toward a consecutive-failure
// budget but don't stop the run on the first occurrence.
//
// Providers that throw a plain Error are treated as transient by default.
export type LlmErrorKind = 'fatal' | 'transient';

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  constructor(kind: LlmErrorKind, message: string) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
  }
}

// Cheap heuristic for HTTP/CLI error messages. Used by providers that don't
// have direct access to a structured status code (e.g. the Claude Code CLI
// only gives us stderr text). Conservative: defaults to transient.
export function classifyErrorMessage(msg: string): LlmErrorKind {
  if (/401|403|invalid.*api.*key|unauthorized|forbidden|authentication/i.test(msg)) return 'fatal';
  if (/model.*not.*found|unknown.*model|no.*such.*model/i.test(msg)) return 'fatal';
  if (/ENOENT|command.*not.*found|not recognized as.*command/i.test(msg)) return 'fatal';
  return 'transient';
}
