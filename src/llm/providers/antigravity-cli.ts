import type { z } from 'zod';
import { LlmError } from '../provider';
import type { HealthcheckResult, LlmProvider, LlmRequest, LlmTask } from '../provider';

// The Antigravity CLI binary is `agy`. As of 2026-05-23 it does not document a
// headless one-shot mode equivalent to `claude --bare -p --output-format json`
// or `gemini --output-format json`, so we ship the provider as a stub that
// fails fast with a clear message. Replace this file once Google publishes a
// supported headless contract.
//
// TODO(antigravity-cli):
//   - Confirm the binary name on the user's PATH (likely `agy`).
//   - Find the equivalent of `--output-format json --json-schema <schema>`
//     and a stdin-pipe prompt mode.
//   - Mirror the spawnClaude / spawnGemini error-handling pattern.
const NOT_READY_MSG =
  "Antigravity CLI provider is a stub — the `agy` binary doesn't yet expose a documented headless JSON mode. Switch to Claude Code, Gemini CLI, or Ollama in Settings → LLM.";

export class AntigravityCliProvider implements LlmProvider {
  readonly name = 'antigravity-cli' as const;

  defaultModelFor(_task: LlmTask): string {
    // Placeholder — call() throws before any code consults this.
    return 'default';
  }

  async call<T>(_req: LlmRequest, _schema: z.ZodType<T>): Promise<T> {
    throw new LlmError('fatal', NOT_READY_MSG);
  }

  async healthcheck(): Promise<HealthcheckResult> {
    return { ok: false, detail: NOT_READY_MSG };
  }
}
