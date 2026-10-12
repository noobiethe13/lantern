import type { z } from 'zod';

// Single source of truth for the LLM task list. Used by:
//   - LlmTask union type (below)
//   - routes/llm-settings.ts schema (z.enum on TASKS)
//   - llm/index.ts settings shape (per_task_overrides validation)
export const LLM_TASKS = ['verdict', 'nl-filter'] as const;
export type LlmTask = (typeof LLM_TASKS)[number];

// claude-code is the only provider since the Phase 8 strip-down.
export type ProviderName = 'claude-code';

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

export interface HealthcheckOptions {
  // Also runs a real model call (proves auth, not just CLI presence). Cheap
  // health checks (Settings mounts, mid-scan) must default this off — see C5.
  deep?: boolean;
}

export interface LlmProvider {
  name: ProviderName;
  call<T>(req: LlmRequest, schema: z.ZodType<T>): Promise<T>;
  healthcheck(opts?: HealthcheckOptions): Promise<HealthcheckResult>;
  defaultModelFor(task: LlmTask): string;
}

// Real model ids look like "claude-opus-4-7", "sonnet", "claude-opus-5-5[1m]" —
// letters/digits/dots/underscores/colons/brackets/hyphens only, starting with
// an alnum. This value is spliced into the CLI argv as the token right after
// `--model` (providers/claude-code.ts), so anything that could be re-parsed as
// a flag (e.g. "--dangerously-skip-permissions") must be rejected before it
// gets there — both where it's written (routes/llm-settings.ts) and where it's
// read back out (llm/index.ts, in case a bad value reaches the DB some other
// way).
export const MODEL_OVERRIDE_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;

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
  // Status codes need context, not a bare digit match — "401"/"403" appear
  // incidentally all over the place (request ids like "req_011CV4031...",
  // unrelated numbers), which previously misclassified transient 5xx/overload
  // errors as fatal whenever one happened to contain "403" as a substring.
  if (/\b(?:API Error:?|status)\s*(401|403)\b/i.test(msg)) return 'fatal';
  if (/invalid.*api.*key|unauthorized|forbidden|authentication/i.test(msg)) return 'fatal';
  if (/not logged in|please run \/login|\/login/i.test(msg)) return 'fatal';
  if (/model.*not.*found|unknown.*model|no.*such.*model/i.test(msg)) return 'fatal';
  // Bun's own missing-executable error ("Executable not found in $PATH:
  // \"claude\"") carries no "ENOENT"/"command not found" text, so it fell
  // through to transient (and got retried) even though a missing CLI never
  // recovers by itself.
  if (/ENOENT|command.*not.*found|executable.*not.*found|not recognized as.*command/i.test(msg)) return 'fatal';
  return 'transient';
}
